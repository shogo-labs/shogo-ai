---
name: data-extract
version: 1.0.0
description: Extract structured data from web pages, files, or APIs
trigger: "extract data|parse|scrape|pull data from|get data from"
tools: [web_fetch, read_file, write_file]
---

# Data Extraction

When the user asks to extract or scrape data:

1. **Identify the source:** URL, file, or API endpoint
2. **Fetch** the content using web_fetch or read_file
3. **Parse** and extract the requested data
4. **Structure** the output in a clean format (table, JSON, CSV)
5. **Save** to a file if requested

## Guidelines

- For HTML pages, identify the relevant data patterns
- For APIs, parse JSON responses and extract key fields
- For files, detect format (CSV, JSON, XML) and parse accordingly
- Present data in the most useful format for the user's needs
- Offer to save as CSV or JSON if the dataset is large

## Output Format

Present extracted data as a markdown table or structured list. For large datasets, save to a file and report the location.
