---
name: campaign-review
description: Analyze recent campaigns and flag issues
---

Using `klaviyo_campaign_summary` for the last 30 days, analyze all campaigns. For each campaign:

1. **Flag underperformers**: open_rate < 20%, click_rate < 2%, unsubscribe_rate > 0.3%
2. **Compare against benchmarks** from the DTC Metrics Reference
3. **Identify top performers** and what made them successful
4. **Provide specific improvement suggestions** for each underperforming campaign:
   - Low opens → subject line, send time, or list targeting issue
   - Low clicks → content, CTA, or design issue
   - High unsubs → frequency, relevance, or list quality issue

Use `klaviyo_campaign_detail` to drill into the worst and best performing campaigns.
