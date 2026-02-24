---
name: database-query
version: 1.0.0
description: Run SQL queries against databases and present results in a readable format
trigger: "query database|sql|run query|database|show tables|select from|db query|data from table"
tools: [exec, read_file, write_file]
---

# Database Query Runner

Execute SQL queries against databases and present results clearly.

## Supported Databases

- **SQLite** — via `sqlite3` CLI
- **PostgreSQL** — via `psql` CLI
- **MySQL** — via `mysql` CLI
- **Any MCP database server** — if installed

## Commands

**Run query:** Execute a SQL query
- Parse natural language into SQL
- Show results as a formatted table
- Warn about destructive operations (DELETE, DROP, TRUNCATE)

**Show tables:** List all tables in a database
- Include column names and types
- Show row counts if possible

**Describe table:** Show table schema
- Column names, types, constraints
- Primary keys and foreign keys
- Sample data (first 5 rows)

**Export results:** Save query results to a file
- CSV, JSON, or markdown table format

## Workflow

1. **Identify** the database type and connection string
2. **Translate** natural language to SQL (if not raw SQL)
3. **Validate** the query — warn on destructive operations
4. **Execute** via the appropriate CLI tool
5. **Format** results as a readable table
6. **Save** to file if requested

## Output Format

**Database:** myapp.db (SQLite)
**Query:** `SELECT name, email, plan FROM users WHERE plan = 'pro' LIMIT 10`
**Rows:** 10 of 234 total

| name | email | plan |
|------|-------|------|
| Alice Johnson | alice@example.com | pro |
| Bob Smith | bob@example.com | pro |
| Carol Lee | carol@example.com | pro |

**Execution time:** 12ms

## Safety Guidelines

- **NEVER** run DROP, TRUNCATE, or DELETE without explicit user confirmation
- Always use LIMIT on SELECT queries (default: 100 rows)
- Show the SQL query before executing for transparency
- For production databases, default to read-only operations
- Warn if connecting to a production database
- Recommend backing up before any write operations

