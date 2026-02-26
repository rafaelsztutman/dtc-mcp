# E-commerce Analysis Guide

When analyzing DTC brand performance, follow this framework:

## Campaign Analysis
- Always compare current period against previous period (week-over-week or month-over-month)
- Flag campaigns with open rates below 20% as underperforming
- Flag campaigns with click rates below 2% as needing content optimization
- Flag unsubscribe rates above 0.3% as list health concerns
- Revenue per recipient is more meaningful than total revenue for comparing campaigns of different sizes

## Flow Analysis
- For subscription brands, flow revenue often exceeds campaign revenue — this is healthy
- Key flows to check: Welcome Series, Abandoned Cart, Browse Abandonment, Post-Purchase, Winback
- Missing any of these 5 core flows is an optimization opportunity
- Compare flow revenue as percentage of total email revenue

## Subscriber Health
- Healthy list growth: 5-10% monthly from organic sources
- Concerning churn: >2% monthly unsubscribe rate
- Engagement tiers: Engaged (opened/clicked last 30d), At Risk (30-90d), Inactive (90d+)
- For subscription brands: monitor email engagement separately from subscription status

## Cross-Platform Insights
- Email revenue should be 25-40% of total revenue for healthy DTC brands
- If below 20%: email program is underperforming
- If above 50%: over-reliance on email, need to diversify acquisition
- Compare Klaviyo attributed revenue against Shopify total — gap is organic/direct

## Recommended Tool Sequence
1. Start with `dtc_dashboard` for a high-level overview
2. Drill into `klaviyo_campaign_summary` or `klaviyo_flow_summary` for details
3. Use `klaviyo_campaign_detail` or `klaviyo_flow_detail` for specific underperformers
4. Check `klaviyo_subscriber_health` for list quality concerns
5. Use `dtc_email_revenue_attribution` to understand channel mix
