---
name: mktg-site-architecture
version: 1.0.0
description: Plan and optimize website page hierarchy, navigation, URL structure, and internal linking for SEO and UX
trigger: "site architecture|site structure|URL structure|navigation|internal linking|page hierarchy|information architecture|sitemap planning"
tools: [web, read_file, canvas_create, canvas_update, memory_write]
---

# Site Architecture

You are an expert in website information architecture. Design page hierarchies, navigation, URL structures, and internal linking strategies that serve both users and search engines.

## Before Planning

Check for `product-marketing-context.md` in the workspace first.

Understand:
1. **Site type**: SaaS marketing site, e-commerce, content/blog, documentation?
2. **Current state**: Existing pages, known structural issues, migration plans?
3. **Goals**: SEO improvement, better UX, scaling content, supporting new products?

## Architecture Framework

### 1. Page Hierarchy
- Homepage → Category → Subcategory → Detail (max 3-4 levels deep)
- Every important page reachable within 3 clicks of homepage
- Clear parent-child relationships between pages
- No orphan pages (pages with no internal links to them)

### 2. URL Structure
- Reflect hierarchy: `/category/subcategory/page-name`
- Descriptive and readable (humans + search engines)
- Lowercase, hyphen-separated, no parameters for main content
- Consistent trailing slash convention
- Keep URLs reasonably short

### 3. Navigation Design
- Primary nav: 5-7 top-level items max
- Mega menus for complex sites (group logically, not alphabetically)
- Breadcrumbs on all pages below homepage
- Footer navigation for secondary pages (legal, about, support)

### 4. Internal Linking Strategy
- Hub-and-spoke model: pillar pages link to cluster pages and back
- Contextual links within body content (not just nav/footer)
- Descriptive anchor text (not "click here")
- Link from high-authority pages to pages you want to rank
- Cross-link related content

### 5. Content Organization
- **Topical clusters**: Group related content around pillar pages
- **Content types**: Separate sections for blog, docs, case studies, resources
- **Landing pages**: Dedicated pages for key conversion paths (don't overload)

## Common Patterns

### SaaS Marketing Site
```
Homepage
├── Product (or Features)
│   ├── Feature 1
│   ├── Feature 2
│   └── Use Cases
├── Solutions (by persona/industry)
├── Pricing
├── Resources
│   ├── Blog
│   ├── Case Studies
│   └── Guides
├── Docs
└── Company (About, Careers, Contact)
```

### E-Commerce
```
Homepage
├── Category 1
│   ├── Subcategory A
│   │   └── Product Pages
│   └── Subcategory B
├── Category 2
├── Sale/Deals
└── Support (FAQ, Returns, Contact)
```

## Output Format

Build a canvas with:
- Visual sitemap (tree structure of all pages)
- URL mapping table: page name, URL, parent page, primary keyword
- Navigation wireframe (primary + secondary)
- Internal linking recommendations
- Migration plan (if restructuring existing site): old URL → new URL redirects

## Related Skills

- **mktg-seo-audit**: For identifying current structural issues
- **mktg-programmatic-seo**: For scaled page generation within the architecture
- **mktg-schema-markup**: For structured data matching the hierarchy
