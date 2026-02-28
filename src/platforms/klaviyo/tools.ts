import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  klaviyoGet,
  klaviyoGetPage,
  klaviyoPaginateAll,
  getCampaignReport,
  getFlowReport,
} from "./client.js";
import {
  transformCampaignSummary,
  transformCampaignDetail,
  transformFlowSummary,
  transformFlowDetail,
  transformSubscriberHealth,
  transformListSegments,
  transformProfiles,
  transformEvents,
} from "./transforms.js";
import {
  formatError,
  toolResult,
} from "../../shared/errors.js";
import { extractKlaviyoCursor } from "../../shared/pagination.js";

const TOOL_ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, openWorldHint: true } as const;

export function registerKlaviyoTools(server: McpServer): void {
  // ---- Tool 1: Campaign Summary ----
  server.tool(
    "klaviyo_campaign_summary",
    "Top campaigns ranked by metric. Returns: name, send_date, opens, clicks, revenue.",
    {
      channel: z
        .enum(["email", "sms"])
        .describe("Channel filter (required by Klaviyo API)"),
      metric: z
        .enum(["revenue", "open_rate", "click_rate", "recipients"])
        .default("revenue")
        .describe("Sort/rank by this metric"),
      days: z
        .number()
        .min(1)
        .max(365)
        .default(30)
        .describe("Lookback period in days"),
      limit: z
        .number()
        .min(1)
        .max(25)
        .default(10)
        .describe("Max campaigns to return"),
    },
    TOOL_ANNOTATIONS,
    async ({ channel, metric, days, limit }) => {
      try {
        // Fetch campaigns with sparse fieldsets
        const campaigns = await klaviyoPaginateAll("campaigns", {
          "filter": `equals(messages.channel,'${channel}'),equals(status,'Sent')`,
          "fields[campaign]": "name,status,archived,send_options,scheduled_at,send_time",
        });

        // Filter to sent campaigns only
        const sentCampaigns = campaigns.filter(
          (c) => c.attributes.status === "Sent",
        );

        if (!sentCampaigns.length) {
          return toolResult({ campaigns: [], message: "No sent campaigns found for this period." });
        }

        // Fetch reporting data (cached, reporting tier)
        // Don't pass campaign IDs — avoids >100 ID limit on contains-any filter.
        // transformCampaignSummary matches report rows to campaigns by ID.
        const reportRows = await getCampaignReport(days);

        const result = transformCampaignSummary(
          sentCampaigns,
          reportRows,
          metric,
          limit,
          channel,
        );

        return toolResult({ campaigns: result, period_days: days, ranked_by: metric });
      } catch (error) {
        return formatError(error);
      }
    },
  );

  // ---- Tool 2: Campaign Detail ----
  server.tool(
    "klaviyo_campaign_detail",
    "Deep dive on one campaign: full metrics, subject line, audiences, send time.",
    {
      campaign_id: z.string().describe("Klaviyo campaign ID"),
    },
    TOOL_ANNOTATIONS,
    async ({ campaign_id }) => {
      try {
        // Fetch campaign with message includes
        const response = await klaviyoGet(`campaigns/${campaign_id}`, {
          "include": "campaign-messages",
          "fields[campaign]":
            "name,status,archived,send_options,scheduled_at,send_time,audiences",
          "fields[campaign-message]": "definition.label,definition.content.subject,definition.channel",
        });

        const campaign = response.data as unknown as {
          id: string;
          attributes: Record<string, unknown>;
        };
        const messages = (response.included ?? []).map((m) => ({
          attributes: m.attributes,
        }));

        // Resolve audience names
        const audienceNames = await resolveAudienceNames(campaign.attributes);

        // Fetch reporting for this campaign
        const reportRows = await getCampaignReport(365, [campaign_id]);

        const result = transformCampaignDetail(
          campaign,
          messages,
          reportRows,
          audienceNames,
        );

        return toolResult(result);
      } catch (error) {
        return formatError(error);
      }
    },
  );

  // ---- Tool 3: Flow Summary ----
  server.tool(
    "klaviyo_flow_summary",
    "Top flows by metric. Returns: name, status, trigger, message_count, revenue.",
    {
      metric: z
        .enum(["revenue", "click_rate", "conversion_rate", "recipients"])
        .default("revenue"),
      days: z.number().min(1).max(365).default(30),
      status: z
        .enum(["live", "draft", "manual", "all"])
        .default("live")
        .describe("Filter by flow status"),
      limit: z.number().min(1).max(25).default(10),
    },
    TOOL_ANNOTATIONS,
    async ({ metric, days, status, limit }) => {
      try {
        const params: Record<string, string> = {
          "fields[flow]": "name,status,trigger_type,archived",
          "include": "flow-actions",
          "page[size]": "50",
        };
        if (status !== "all") {
          params.filter = `equals(status,'${status}')`;
        }

        // Fetch flows with flow-actions included — avoids N+1 queries
        const flows = await klaviyoPaginateAll("flows", params);

        if (!flows.length) {
          return toolResult({ flows: [], message: "No flows found." });
        }

        // Count flow-actions per flow from relationship linkage data
        const flowsWithCounts = flows.map((f) => {
          const rel = f.relationships?.["flow-actions"] as
            | { data?: Array<{ id: string }> }
            | undefined;
          return {
            ...f,
            messageCount: Array.isArray(rel?.data) ? rel.data.length : 0,
          };
        });

        // Fetch flow reporting (cached, reporting tier)
        // Don't pass flow IDs — avoids >100 ID limit on contains-any filter.
        // transformFlowSummary matches report rows to flows by ID.
        const reportRows = await getFlowReport(days);

        const result = transformFlowSummary(
          flowsWithCounts,
          reportRows,
          metric,
          limit,
        );

        return toolResult({ flows: result, period_days: days, ranked_by: metric });
      } catch (error) {
        return formatError(error);
      }
    },
  );

  // ---- Tool 4: Flow Detail ----
  server.tool(
    "klaviyo_flow_detail",
    "Deep dive on one flow: per-message performance breakdown.",
    {
      flow_id: z.string().describe("Klaviyo flow ID"),
      days: z.number().min(1).max(365).default(30),
    },
    TOOL_ANNOTATIONS,
    async ({ flow_id, days }) => {
      try {
        // Step 1: Fetch flow with its actions (flow-messages not allowed on flows endpoint)
        const response = await klaviyoGet(`flows/${flow_id}`, {
          "include": "flow-actions",
          "fields[flow]": "name,status,trigger_type",
        });

        const flow = response.data as unknown as {
          id: string;
          attributes: Record<string, unknown>;
        };

        // Step 2: For each action, fetch its messages
        const actionIds = (response.included ?? [])
          .filter((i) => i.type === "flow-action")
          .map((a) => a.id);

        const messages: Array<{ id: string; attributes: Record<string, unknown> }> = [];
        for (const actionId of actionIds) {
          const actionResp = await klaviyoGet(`flow-actions/${actionId}`, {
            "include": "flow-messages",
          });
          const actionMessages = (actionResp.included ?? [])
            .filter((i) => i.type === "flow-message")
            .map((m) => ({ id: m.id, attributes: m.attributes }));
          messages.push(...actionMessages);
        }

        // Fetch flow reporting grouped by message
        const reportRows = await getFlowReport(days, [flow_id]);

        const result = transformFlowDetail(flow, messages, reportRows);

        return toolResult(result);
      } catch (error) {
        return formatError(error);
      }
    },
  );

  // ---- Tool 5: Subscriber Health ----
  server.tool(
    "klaviyo_subscriber_health",
    "List growth and engagement tier breakdown. Pre-aggregated health snapshot.",
    {
      list_id: z
        .string()
        .optional()
        .describe("Specific list ID, or omit for all lists"),
    },
    TOOL_ANNOTATIONS,
    async ({ list_id }) => {
      try {
        let lists;
        if (list_id) {
          const response = await klaviyoGet(`lists/${list_id}`, {
            "fields[list]": "name,created,updated",
          });
          lists = [response.data as unknown as { id: string; attributes: Record<string, unknown> }];
        } else {
          lists = await klaviyoPaginateAll("lists", {
            "fields[list]": "name,created,updated",
          });
        }

        // Fetch segments for engagement tiers
        const segments = await klaviyoPaginateAll("segments", {
          "fields[segment]": "name,created,updated",
        });

        const result = transformSubscriberHealth(lists, segments);

        return toolResult(result);
      } catch (error) {
        return formatError(error);
      }
    },
  );

  // ---- Tool 6: List & Segments ----
  server.tool(
    "klaviyo_list_segments",
    "All lists and segments with sizes. No full definitions.",
    {
      type: z
        .enum(["lists", "segments", "all"])
        .default("all")
        .describe("Filter by type"),
      cursor: z
        .string()
        .optional()
        .describe("Pagination cursor from previous response"),
    },
    TOOL_ANNOTATIONS,
    async ({ type, cursor }) => {
      try {
        const lists =
          type === "segments"
            ? []
            : (
                await klaviyoGetPage(
                  "lists",
                  {
                    "fields[list]": "name,created,updated",
                  },
                  type === "lists" ? cursor : undefined,
                )
              ).data;

        const listsLinks =
          type === "segments"
            ? undefined
            : (
                await klaviyoGet("lists", {
                  "fields[list]": "name,created,updated",
                  ...(cursor && type === "lists"
                    ? { "page[cursor]": cursor }
                    : {}),
                })
              ).links;

        const segments =
          type === "lists"
            ? []
            : (
                await klaviyoGetPage(
                  "segments",
                  {
                    "fields[segment]": "name,created,updated",
                  },
                  type === "segments" ? cursor : undefined,
                )
              ).data;

        const items = transformListSegments(lists, segments);
        const nextCursor = extractKlaviyoCursor(listsLinks);

        return toolResult({
          items,
          next_cursor: nextCursor,
          has_more: nextCursor !== null,
        });
      } catch (error) {
        return formatError(error);
      }
    },
  );

  // ---- Tool 7: Search Profiles ----
  server.tool(
    "klaviyo_search_profiles",
    "Find profiles by email, phone, or name. Returns key fields only.",
    {
      query: z
        .string()
        .describe("Email address, phone number, or name to search"),
      limit: z.number().min(1).max(10).default(5),
    },
    TOOL_ANNOTATIONS,
    async ({ query, limit }) => {
      try {
        // Detect query type
        let filter: string;
        if (query.includes("@")) {
          filter = `equals(email,"${query}")`;
        } else if (query.startsWith("+") || /^\d{10,}$/.test(query)) {
          filter = `equals(phone_number,"${query}")`;
        } else {
          // Name search — try first_name contains
          filter = `contains(first_name,"${query}")`;
        }

        const response = await klaviyoGet("profiles", {
          filter,
          "fields[profile]":
            "email,first_name,last_name,phone_number,created,location",
          "page[size]": String(limit),
        });

        const result = transformProfiles(response.data ?? []);

        return toolResult({ profiles: result });
      } catch (error) {
        return formatError(error);
      }
    },
  );

  // ---- Tool 8: Recent Activity ----
  server.tool(
    "klaviyo_recent_activity",
    "Recent events for a metric (e.g., Placed Order, Opened Email). Last N events.",
    {
      metric_name: z
        .string()
        .default("Placed Order")
        .describe("Metric name like 'Placed Order', 'Opened Email'"),
      days: z.number().min(1).max(90).default(7),
      limit: z.number().min(1).max(25).default(10),
      profile_email: z
        .string()
        .optional()
        .describe("Filter to specific profile email"),
    },
    TOOL_ANNOTATIONS,
    async ({ metric_name, days, limit, profile_email }) => {
      try {
        // Resolve metric name to ID
        const metricsResponse = await klaviyoGet("metrics", {
          filter: `equals(name,"${metric_name}")`,
          "fields[metric]": "name",
        });

        if (!metricsResponse.data?.length) {
          return toolResult({
            events: [],
            message: `No metric found with name "${metric_name}".`,
          });
        }

        const metricId = metricsResponse.data[0].id;

        // Build events filter
        const since = new Date();
        since.setDate(since.getDate() - days);
        let filter = `greater-or-equal(datetime,${since.toISOString()})`;
        filter += `,equals(metric_id,"${metricId}")`;

        if (profile_email) {
          // First find profile by email
          const profileResp = await klaviyoGet("profiles", {
            filter: `equals(email,"${profile_email}")`,
            "fields[profile]": "email",
          });
          if (profileResp.data?.length) {
            filter += `,equals(profile_id,"${profileResp.data[0].id}")`;
          }
        }

        const response = await klaviyoGet("events", {
          filter,
          include: "profile",
          "fields[event]": "datetime,event_properties",
          "fields[profile]": "email,first_name,last_name",
          sort: "-datetime",
        });

        // Build profile lookup from included
        const profileMap = new Map<
          string,
          { email?: string; first_name?: string; last_name?: string }
        >();
        for (const included of response.included ?? []) {
          if (included.type === "profile") {
            profileMap.set(included.id, {
              email: included.attributes.email as string | undefined,
              first_name: included.attributes.first_name as
                | string
                | undefined,
              last_name: included.attributes.last_name as string | undefined,
            });
          }
        }

        const result = transformEvents(
          (response.data ?? []).slice(0, limit),
          profileMap,
          metric_name,
        );

        return toolResult({
          events: result,
          metric: metric_name,
          period_days: days,
        });
      } catch (error) {
        return formatError(error);
      }
    },
  );
}

// ---- Helpers ----

async function resolveAudienceNames(
  attrs: Record<string, unknown>,
): Promise<string[]> {
  const audiences = attrs.audiences as
    | { included?: Array<{ id: string }>; excluded?: Array<{ id: string }> }
    | undefined;
  if (!audiences?.included?.length) return [];

  const names: string[] = [];
  for (const audience of audiences.included) {
    try {
      // Try as list first, then segment
      const listResp = await klaviyoGet(`lists/${audience.id}`, {
        "fields[list]": "name",
      });
      const data = listResp.data as unknown as {
        attributes: { name: string };
      };
      names.push(data.attributes.name);
    } catch {
      try {
        const segResp = await klaviyoGet(`segments/${audience.id}`, {
          "fields[segment]": "name",
        });
        const data = segResp.data as unknown as {
          attributes: { name: string };
        };
        names.push(data.attributes.name);
      } catch {
        names.push(audience.id); // fallback to ID
      }
    }
  }
  return names;
}
