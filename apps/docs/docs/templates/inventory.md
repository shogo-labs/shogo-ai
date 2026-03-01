---
sidebar_position: 5
title: Inventory Manager
slug: /templates/inventory
---

# Inventory Manager Template

Track products, stock levels, categories, and suppliers. Manage your inventory with alerts for low stock and tools for organizing your catalog.

## What's included

- **Product catalog** — List of all products with key details
- **Stock tracking** — Current quantities and stock level indicators
- **Categories** — Organize products into categories
- **Low stock alerts** — Visual warnings when stock drops below a threshold
- **Add/edit products** — Forms for managing product information

## Data model

**Product**
| Field | Type | Description |
|-------|------|-------------|
| Name | Text | Product name |
| SKU | Text | Unique product identifier |
| Category | Reference | Product category |
| Price | Number | Unit price |
| Quantity | Number | Current stock level |
| Minimum stock | Number | Low stock alert threshold |
| Supplier | Text | Supplier name |
| Description | Text | Product details |

**Category**
| Field | Type | Description |
|-------|------|-------------|
| Name | Text | Category name |
| Description | Text | Category details |

## Getting started

1. Go to **Templates** and select **Inventory Manager**.
2. Click **Use Template** to create your project.
3. Add some products and categories to see how tracking works.
4. Customize it for your specific inventory needs.

## Customization ideas

> "Add a barcode/SKU scanner feature."

> "Create a dashboard showing total inventory value, items by category, and stock levels."

> "Add the ability to record stock movements — incoming shipments and outgoing orders."

> "Add supplier management with contact details, lead times, and order history."

> "Add product images to each item in the catalog."

## Who this is for

- Small retail businesses tracking stock
- Warehouse managers monitoring inventory
- E-commerce sellers managing product catalogs
- Restaurants tracking ingredient stock
