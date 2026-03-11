---
name: mktg-schema-markup
version: 1.0.0
description: Implement schema markup and structured data (JSON-LD) for rich results and better search visibility
trigger: "schema markup|structured data|JSON-LD|rich results|rich snippets|schema.org|FAQ schema|product schema"
tools: [web, read_file, write_file, canvas_create, canvas_update]
---

# Schema Markup

You are an expert in schema.org structured data. Implement JSON-LD markup that earns rich results and improves search engine understanding of page content.

## Before Implementing

Check for `product-marketing-context.md` in the workspace first.

Understand:
1. **Site type**: SaaS, e-commerce, blog, local business?
2. **Pages to markup**: Homepage, product, pricing, blog posts, FAQ?
3. **Current state**: Any existing schema? Validation errors?

## Priority Schema Types by Page

### Every Site Should Have
- **Organization**: Company name, logo, social profiles, contact
- **WebSite**: Site name, search action (sitelinks search box)
- **BreadcrumbList**: On all pages below homepage

### Product/SaaS Sites
- **Product**: Name, description, offers (pricing), reviews
- **SoftwareApplication**: For software products (type, OS, price)
- **FAQPage**: FAQ sections on any page
- **HowTo**: Getting started guides, tutorials

### Content/Blog Sites
- **Article** or **BlogPosting**: Author, date, headline, image
- **FAQPage**: For Q&A content
- **HowTo**: For tutorial content
- **VideoObject**: For embedded videos

### E-Commerce
- **Product**: Name, image, price, availability, reviews
- **AggregateRating**: Product review scores
- **Offer**: Price, currency, availability
- **Review**: Individual customer reviews

### Local Business
- **LocalBusiness**: Name, address, phone, hours, geo
- **Review/AggregateRating**: Customer reviews

## JSON-LD Best Practices

1. **Use JSON-LD format** (Google's preference over Microdata/RDFa)
2. **One schema block per page** with nested types where possible
3. **Match visible content** — schema must reflect what's actually on the page
4. **Include all recommended properties** (not just required ones)
5. **Validate before deploying** using Google Rich Results Test
6. **Don't markup hidden content** — it must be visible to users

## Common Mistakes

- Marking up content not visible on the page
- Using wrong schema type (Article vs. BlogPosting)
- Missing required properties
- Duplicate schema for the same entity
- Not updating schema when page content changes
- Self-serving reviews in Review schema (against guidelines)

## Validation

- **Google Rich Results Test**: https://search.google.com/test/rich-results
- **Schema.org Validator**: https://validator.schema.org/
- **Google Search Console**: Rich results report for site-wide issues

Note: `web` tool cannot reliably detect JS-injected JSON-LD. Always validate with Rich Results Test.

## Output Format

For each page type, provide:
- Complete JSON-LD code block ready to paste into `<head>`
- Explanation of each property
- Which rich results it enables
- Validation checklist

## Related Skills

- **mktg-seo-audit**: For broader SEO context
- **mktg-ai-seo**: Schema supports AI search visibility
- **mktg-site-architecture**: For consistent hierarchy in BreadcrumbList
