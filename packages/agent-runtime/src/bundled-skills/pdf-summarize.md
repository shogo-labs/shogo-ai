---
name: pdf-summarize
version: 1.0.0
description: Extract text from PDFs and documents, then summarize the content
trigger: "pdf|summarize document|read document|extract from pdf|document summary|paper summary"
tools: [exec, read_file, write_file, web_fetch]
---

# PDF & Document Summarizer

Extract text from PDF files or document URLs and provide structured summaries.

## Workflow

1. **Locate the document:**
   - If a URL is provided, download using web_fetch
   - If a local file, read from workspace

2. **Extract text:**
   - Use `pdftotext` CLI tool (exec) for PDF files
   - Fall back to `strings` command if pdftotext unavailable
   - For web pages, use web_fetch directly

3. **Analyze and summarize:**
   - Identify document type (research paper, report, legal, invoice)
   - Extract key sections, headings, and main points
   - Generate a structured summary

4. **Save if requested:**
   - Write summary to a markdown file
   - Include source reference and extraction date

## Output Format

**Document:** Annual Report 2025.pdf
**Type:** Financial Report | **Pages:** 42 | **Words:** ~18,500

### Key Takeaways
1. Revenue grew 23% YoY to $4.2B
2. New product line launched in Q3
3. Headcount increased to 12,500 employees

### Executive Summary
[2-3 paragraph summary of the document]

### Important Figures
- Revenue: $4.2B (+23%)
- Net Income: $890M (+15%)
- R&D Spend: $620M (14.8% of revenue)

### Action Items / Recommendations
- [If applicable, list action items from the document]

## Guidelines

- For research papers, focus on abstract, methodology, results, and conclusions
- For legal documents, highlight key terms, obligations, and dates
- For invoices/receipts, extract line items, totals, and payment terms
- Always mention the source file and extraction date
- Warn if text extraction quality is poor (scanned PDFs may need OCR)

