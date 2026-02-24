---
name: stock-price
version: 1.0.0
description: Get stock prices, crypto prices, market data, and set price alerts
trigger: "stock|share price|market|crypto|bitcoin|ethereum|portfolio|ticker|nasdaq|s&p|nifty"
tools: [web_fetch, memory_read, memory_write]
---

# Stock & Crypto Price Checker

Fetch real-time and historical price data for stocks, cryptocurrencies, and market indices.

## Capabilities

**Price check:** Get current price for a stock or crypto
- Support ticker symbols (AAPL, TSLA, BTC, ETH)
- Show price change (absolute and percentage)
- Include volume and market cap when available

**Market overview:** Summarize major indices
- S&P 500, NASDAQ, Dow Jones
- Key crypto (BTC, ETH, SOL)
- Regional markets if requested (NIFTY, FTSE, Nikkei)

**Price alerts:** Set alerts for price thresholds
- Save to memory for checking on heartbeat ticks
- Alert when price crosses above/below target

**Portfolio tracking:** Track a portfolio of holdings
- Calculate total value and daily change
- Show per-holding performance

## Output Format

**AAPL (Apple Inc.)** — $187.45
📈 +$2.30 (+1.24%) today
Volume: 52.3M | Market Cap: $2.89T | P/E: 29.8

**BTC (Bitcoin)** — $97,234.50
📉 -$1,245.00 (-1.26%) today
24h Volume: $38.2B | Market Cap: $1.91T

## Data Sources

- Use web_fetch to query financial data from public sources
- Yahoo Finance, Google Finance, CoinGecko for crypto
- Parse the response for relevant price data
- Cache recent lookups in memory to avoid redundant fetches

## Guidelines

- Always show currency (USD, EUR, etc.)
- Include daily change with direction emoji (📈/📉)
- For portfolios, calculate weighted returns
- Remind users that data may be delayed (15-20 min for free sources)

