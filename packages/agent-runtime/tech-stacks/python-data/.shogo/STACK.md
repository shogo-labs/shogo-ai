# Tech Stack — Python Data Science

## Project Structure

Your workspace is a **Python data science** project with Jupyter, pandas, matplotlib, and plotly. Write Python scripts or Jupyter notebooks to analyze and visualize data.

```
notebooks/
  analysis.ipynb       ← Jupyter notebooks for interactive exploration
scripts/
  process.py           ← Python scripts for data processing pipelines
data/
  raw/                 ← Raw input data (CSV, JSON, Excel, etc.)
  processed/           ← Cleaned/transformed output data
output/
  figures/             ← Saved charts and visualizations
  reports/             ← Generated reports
requirements.txt       ← Python dependencies
setup.sh               ← Environment setup script
```

## How It Works

1. Write Python scripts under `scripts/` or notebooks under `notebooks/` using `write_file`
2. Run scripts with `exec({ command: "python scripts/process.py" })`
3. For Jupyter notebooks, edit the `.ipynb` file directly or run cells via `exec`
4. Output figures and data to `output/`

## Available Libraries

**pandas** — Data manipulation and analysis
```python
import pandas as pd
df = pd.read_csv('data/raw/sales.csv')
df.groupby('region').sum()
df.to_csv('data/processed/summary.csv', index=False)
```

**matplotlib** — Static charts and plots
```python
import matplotlib.pyplot as plt
fig, ax = plt.subplots(figsize=(10, 6))
ax.bar(df['category'], df['revenue'])
ax.set_title('Revenue by Category')
plt.tight_layout()
plt.savefig('output/figures/revenue.png', dpi=150)
plt.close()
```

**plotly** — Interactive charts
```python
import plotly.express as px
fig = px.line(df, x='date', y='value', color='category', title='Trends Over Time')
fig.write_html('output/figures/trends.html')
```

**seaborn** — Statistical visualizations
```python
import seaborn as sns
sns.heatmap(df.corr(), annot=True, cmap='coolwarm')
plt.savefig('output/figures/correlation.png')
```

**numpy / scipy** — Numerical computing
```python
import numpy as np
from scipy import stats
```

**openpyxl** — Excel file read/write
```python
df = pd.read_excel('data/raw/report.xlsx', sheet_name='Sheet1')
df.to_excel('output/reports/summary.xlsx', index=False)
```

**Installing new packages** — `exec({ command: "pip install <package-name>" })`

## Data Processing Patterns

### Load and clean data
```python
import pandas as pd

df = pd.read_csv('data/raw/sales.csv')
df.columns = df.columns.str.strip().str.lower().str.replace(' ', '_')
df['date'] = pd.to_datetime(df['date'])
df = df.dropna(subset=['revenue'])
df = df[df['revenue'] > 0]
print(f"Loaded {len(df)} rows")
df.to_csv('data/processed/sales_clean.csv', index=False)
```

### Aggregation and summary
```python
summary = df.groupby('region').agg(
    total_revenue=('revenue', 'sum'),
    avg_order=('revenue', 'mean'),
    num_orders=('revenue', 'count'),
).round(2).sort_values('total_revenue', ascending=False)
print(summary)
```

### Multi-chart dashboard
```python
import matplotlib.pyplot as plt

fig, axes = plt.subplots(2, 2, figsize=(14, 10))

axes[0, 0].bar(summary.index, summary['total_revenue'])
axes[0, 0].set_title('Revenue by Region')

axes[0, 1].plot(daily['date'], daily['revenue'])
axes[0, 1].set_title('Daily Revenue Trend')

axes[1, 0].pie(category_totals, labels=category_totals.index, autopct='%1.0f%%')
axes[1, 0].set_title('Revenue by Category')

axes[1, 1].hist(df['revenue'], bins=30, edgecolor='black')
axes[1, 1].set_title('Order Value Distribution')

plt.tight_layout()
plt.savefig('output/figures/dashboard.png', dpi=150)
plt.close()
print("Dashboard saved to output/figures/dashboard.png")
```

### Jupyter notebook workflow
```python
# To create and run a notebook programmatically:
exec({ command: "jupyter nbconvert --execute notebooks/analysis.ipynb --to html --output ../output/reports/analysis.html" })
```

## Important Rules

- Always save figures to `output/figures/` with `plt.savefig()` — don't rely on `plt.show()` (no display in the runtime)
- Call `plt.close()` after saving to free memory
- Use `print()` to show results — output appears in the exec result
- Read data from `data/raw/`, write processed data to `data/processed/`
- For large datasets, use chunked reading: `pd.read_csv(file, chunksize=10000)`
- Always set `figsize` on matplotlib figures for consistent output
- Use `dpi=150` for saved figures (good balance of quality and file size)
- When the user provides data files, copy them to `data/raw/` first

## Running Scripts

```
exec({ command: "python scripts/process.py" })
exec({ command: "python -c \"import pandas as pd; print(pd.read_csv('data/raw/file.csv').head())\"" })
exec({ command: "jupyter nbconvert --execute notebooks/analysis.ipynb --to html" })
```
