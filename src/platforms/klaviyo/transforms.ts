import type {
  CampaignSummaryItem,
  CampaignDetail,
  FlowSummaryItem,
  FlowDetail,
  FlowDetailMessage,
  SubscriberHealth,
  ListSegmentItem,
  ProfileResult,
  ActivityEvent,
} from "../../shared/types.js";

// ---- Raw Klaviyo API response types ----

interface KlaviyoReportRow {
  groupings: {
    campaign_id?: string;
    flow_id?: string;
    flow_message_id?: string;
    send_channel?: string;
  };
  statistics: Record<string, number>;
}

// ---- Campaign Transforms ----

export function transformCampaignSummary(
  campaigns: Array<{ id: string; attributes: Record<string, unknown> }>,
  reportRows: KlaviyoReportRow[],
  metric: string,
  limit: number,
  channel = "email",
): CampaignSummaryItem[] {
  const metricsById = new Map<string, Record<string, number>>();
  for (const row of reportRows) {
    const id = row.groupings.campaign_id;
    if (!id) continue;
    // Merge stats if grouped by message — sum them up for the campaign
    const existing = metricsById.get(id) ?? {};
    for (const [key, val] of Object.entries(row.statistics)) {
      existing[key] = (existing[key] ?? 0) + val;
    }
    metricsById.set(id, existing);
  }

  const results: CampaignSummaryItem[] = campaigns.map((c) => {
    const attrs = c.attributes;
    const stats = metricsById.get(c.id) ?? {};
    const recipients = stats.recipients ?? 0;

    return {
      id: c.id,
      name: String(attrs.name ?? ""),
      channel,
      status: String(attrs.status ?? "unknown"),
      send_date: extractSendDate(attrs),
      recipients,
      open_rate: safeRate(stats.opens_unique ?? stats.opens, recipients),
      click_rate: safeRate(stats.clicks_unique ?? stats.clicks, recipients),
      revenue: stats.conversion_value ?? 0,
      unsubscribe_rate: safeRate(stats.unsubscribes, recipients),
    };
  });

  // Sort by requested metric descending
  results.sort((a, b) => {
    const valA = (a as unknown as Record<string, number>)[metric];
    const valB = (b as unknown as Record<string, number>)[metric];
    return (valB ?? 0) - (valA ?? 0);
  });

  return results.slice(0, limit);
}

export function transformCampaignDetail(
  campaign: { id: string; attributes: Record<string, unknown> },
  messages: Array<{ attributes: Record<string, unknown> }>,
  reportRows: KlaviyoReportRow[],
  audienceNames: string[],
): CampaignDetail {
  const attrs = campaign.attributes;
  // Sum all report rows for this campaign
  const stats: Record<string, number> = {};
  for (const row of reportRows) {
    for (const [key, val] of Object.entries(row.statistics)) {
      stats[key] = (stats[key] ?? 0) + val;
    }
  }

  const recipients = stats.recipients ?? 0;
  const opens = stats.opens_unique ?? stats.opens ?? 0;

  return {
    id: campaign.id,
    name: String(attrs.name ?? ""),
    channel: extractChannelFromMessages(messages),
    status: String(attrs.status ?? "unknown"),
    subject_line: extractSubjectLine(messages),
    send_date: extractSendDate(attrs),
    audiences: audienceNames,
    recipients,
    open_rate: safeRate(opens, recipients),
    click_rate: safeRate(stats.clicks_unique ?? stats.clicks, recipients),
    click_through_rate: safeRate(stats.clicks_unique ?? stats.clicks, opens),
    revenue: stats.conversion_value ?? 0,
    unsubscribe_rate: safeRate(stats.unsubscribes, recipients),
    bounce_rate: safeRate(stats.bounced, recipients),
    spam_rate: safeRate(stats.spam_complaints, recipients),
  };
}

// ---- Flow Transforms ----

export function transformFlowSummary(
  flows: Array<{
    id: string;
    attributes: Record<string, unknown>;
    messageCount: number;
  }>,
  reportRows: KlaviyoReportRow[],
  metric: string,
  limit: number,
): FlowSummaryItem[] {
  // Group report rows by flow_id and sum stats
  const metricsById = new Map<string, Record<string, number>>();
  for (const row of reportRows) {
    const id = row.groupings.flow_id;
    if (!id) continue;
    const existing = metricsById.get(id) ?? {};
    for (const [key, val] of Object.entries(row.statistics)) {
      existing[key] = (existing[key] ?? 0) + val;
    }
    metricsById.set(id, existing);
  }

  const results: FlowSummaryItem[] = flows.map((f) => {
    const attrs = f.attributes;
    const stats = metricsById.get(f.id) ?? {};
    const recipients = stats.recipients ?? 0;

    return {
      id: f.id,
      name: String(attrs.name ?? ""),
      status: String(attrs.status ?? "unknown"),
      trigger_type: String(attrs.trigger_type ?? "unknown"),
      message_count: f.messageCount,
      recipients,
      click_rate: safeRate(stats.clicks_unique ?? stats.clicks, recipients),
      revenue: stats.conversion_value ?? 0,
      conversion_rate: safeRate(stats.conversions, recipients),
    };
  });

  results.sort((a, b) => {
    const valA = (a as unknown as Record<string, number>)[metric];
    const valB = (b as unknown as Record<string, number>)[metric];
    return (valB ?? 0) - (valA ?? 0);
  });

  return results.slice(0, limit);
}

export function transformFlowDetail(
  flow: { id: string; attributes: Record<string, unknown> },
  messages: Array<{
    id: string;
    attributes: Record<string, unknown>;
  }>,
  reportRows: KlaviyoReportRow[],
): FlowDetail {
  const attrs = flow.attributes;

  // Group report rows by flow_message_id
  const metricsByMessageId = new Map<string, Record<string, number>>();
  const totalStats: Record<string, number> = {};

  for (const row of reportRows) {
    const msgId = row.groupings.flow_message_id;
    for (const [key, val] of Object.entries(row.statistics)) {
      totalStats[key] = (totalStats[key] ?? 0) + val;
    }
    if (msgId) {
      const existing = metricsByMessageId.get(msgId) ?? {};
      for (const [key, val] of Object.entries(row.statistics)) {
        existing[key] = (existing[key] ?? 0) + val;
      }
      metricsByMessageId.set(msgId, existing);
    }
  }

  const messageDetails: FlowDetailMessage[] = messages.map((m) => {
    const mAttrs = m.attributes;
    const stats = metricsByMessageId.get(m.id) ?? {};
    const recipients = stats.recipients ?? 0;

    return {
      message_id: m.id,
      message_name: String(mAttrs.name ?? ""),
      subject_line: mAttrs.subject
        ? String(mAttrs.subject)
        : mAttrs.label
          ? String(mAttrs.label)
          : null,
      status: String(mAttrs.status ?? "unknown"),
      recipients,
      open_rate: safeRate(stats.opens_unique ?? stats.opens, recipients),
      click_rate: safeRate(stats.clicks_unique ?? stats.clicks, recipients),
      revenue: stats.conversion_value ?? 0,
    };
  });

  return {
    id: flow.id,
    name: String(attrs.name ?? ""),
    status: String(attrs.status ?? "unknown"),
    trigger_type: String(attrs.trigger_type ?? "unknown"),
    total_revenue: totalStats.conversion_value ?? 0,
    total_recipients: totalStats.recipients ?? 0,
    messages: messageDetails,
  };
}

// ---- Subscriber / List / Segment Transforms ----

export function transformSubscriberHealth(
  lists: Array<{
    id: string;
    attributes: Record<string, unknown>;
  }>,
  segments: Array<{
    id: string;
    attributes: Record<string, unknown>;
  }>,
): SubscriberHealth {
  const transformedLists = lists.map((l) => ({
    id: l.id,
    name: String(l.attributes.name ?? ""),
    size: Number(l.attributes.profile_count ?? 0),
  }));

  const transformedSegments = segments.map((s) => ({
    id: s.id,
    name: String(s.attributes.name ?? ""),
    estimated_size: Number(s.attributes.profile_count ?? 0),
  }));

  const total = transformedLists.reduce((sum, l) => sum + l.size, 0);

  return {
    total_subscribers: total,
    lists: transformedLists
      .sort((a, b) => b.size - a.size)
      .slice(0, 10),
    segments: transformedSegments
      .sort((a, b) => b.estimated_size - a.estimated_size)
      .slice(0, 10),
  };
}

export function transformListSegments(
  lists: Array<{
    id: string;
    attributes: Record<string, unknown>;
  }>,
  segments: Array<{
    id: string;
    attributes: Record<string, unknown>;
  }>,
): ListSegmentItem[] {
  const items: ListSegmentItem[] = [];

  for (const l of lists) {
    items.push({
      id: l.id,
      name: String(l.attributes.name ?? ""),
      type: "list",
      size: Number(l.attributes.profile_count ?? 0),
      created_at: String(l.attributes.created ?? ""),
      updated_at: String(l.attributes.updated ?? ""),
    });
  }

  for (const s of segments) {
    items.push({
      id: s.id,
      name: String(s.attributes.name ?? ""),
      type: "segment",
      size: Number(s.attributes.profile_count ?? 0),
      created_at: String(s.attributes.created ?? ""),
      updated_at: String(s.attributes.updated ?? ""),
    });
  }

  return items;
}

// ---- Profile Transforms ----

export function transformProfiles(
  profiles: Array<{
    id: string;
    attributes: Record<string, unknown>;
  }>,
): ProfileResult[] {
  return profiles.map((p) => {
    const attrs = p.attributes;
    const location = attrs.location as Record<string, unknown> | undefined;

    return {
      email: attrs.email ? String(attrs.email) : null,
      first_name: attrs.first_name ? String(attrs.first_name) : null,
      last_name: attrs.last_name ? String(attrs.last_name) : null,
      phone_number: attrs.phone_number ? String(attrs.phone_number) : null,
      city: location?.city ? String(location.city) : null,
      country: location?.country ? String(location.country) : null,
      created_at: String(attrs.created ?? ""),
    };
  });
}

// ---- Event Transforms ----

export function transformEvents(
  events: Array<{
    attributes: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  }>,
  includedProfiles: Map<
    string,
    { email?: string; first_name?: string; last_name?: string }
  >,
  metricName: string,
): ActivityEvent[] {
  return events.map((e) => {
    const attrs = e.attributes;
    const profileId = extractRelationshipId(e.relationships, "profile");
    const profile = profileId ? includedProfiles.get(profileId) : undefined;

    // Strip event properties to high-signal fields based on metric type
    const rawProps =
      (attrs.event_properties as Record<string, unknown>) ?? {};
    const props = stripEventProperties(rawProps, metricName);

    return {
      timestamp: String(attrs.datetime ?? ""),
      profile_email: profile?.email ?? null,
      profile_name: profile
        ? [profile.first_name, profile.last_name].filter(Boolean).join(" ") ||
          null
        : null,
      event_properties: props,
    };
  });
}

// ---- Helpers ----

function safeRate(numerator: number | undefined, denominator: number): number {
  if (!denominator || !numerator) return 0;
  return Math.round((numerator / denominator) * 10000) / 10000; // 4 decimal places
}

function extractChannelFromMessages(
  messages: Array<{ attributes: Record<string, unknown> }>,
): string {
  if (!messages.length) return "email";
  const first = messages[0].attributes;
  const def = first.definition as Record<string, unknown> | undefined;
  if (def?.channel) return String(def.channel);
  // Fallback for flow messages
  if (first.channel) return String(first.channel);
  return "email";
}

function extractSendDate(attrs: Record<string, unknown>): string | null {
  return (
    (attrs.send_time as string) ??
    (attrs.scheduled_at as string) ??
    null
  );
}

function extractSubjectLine(
  messages: Array<{ attributes: Record<string, unknown> }>,
): string | null {
  if (!messages.length) return null;
  const first = messages[0].attributes;
  // Campaign messages nest fields under definition
  const def = first.definition as Record<string, unknown> | undefined;
  if (def) {
    const content = def.content as Record<string, unknown> | undefined;
    if (content?.subject) return String(content.subject);
    if (def.label) return String(def.label);
  }
  // Fallback for flow messages (top-level fields)
  return first.subject ? String(first.subject) : first.label ? String(first.label) : null;
}

function extractRelationshipId(
  relationships: Record<string, unknown> | undefined,
  name: string,
): string | null {
  if (!relationships) return null;
  const rel = relationships[name] as
    | { data?: { id?: string } }
    | undefined;
  return rel?.data?.id ?? null;
}

function stripEventProperties(
  props: Record<string, unknown>,
  metricName: string,
): Record<string, unknown> {
  const normalized = metricName.toLowerCase();

  // For "Placed Order" — keep order value, items, and currency
  if (normalized.includes("placed order") || normalized.includes("order")) {
    return pick(props, [
      "$value",
      "value",
      "Items",
      "ItemNames",
      "ItemCount",
      "Currency",
      "OrderId",
    ]);
  }

  // For email events — keep campaign/flow context
  if (
    normalized.includes("opened") ||
    normalized.includes("clicked") ||
    normalized.includes("received")
  ) {
    return pick(props, [
      "Subject",
      "CampaignName",
      "FlowName",
      "$flow",
      "$message",
      "URL",
    ]);
  }

  // Default: return top-level keys only, no nested objects
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(props)) {
    if (typeof val !== "object" || val === null) {
      result[key] = val;
    }
  }
  return result;
}

function pick(
  obj: Record<string, unknown>,
  keys: string[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (key in obj) {
      result[key] = obj[key];
    }
  }
  return result;
}
