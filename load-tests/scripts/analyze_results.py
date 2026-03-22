#!/usr/bin/env python3
"""
Analyzes Locust test results and generates summary report.

Usage:
    python scripts/analyze_results.py --report reports/auth_test
    python scripts/analyze_results.py --all  # Analyze all reports
"""
import argparse
import pandas as pd
import glob
import os
from pathlib import Path


def analyze_csv(csv_prefix: str):
    """Analyze Locust CSV results."""
    stats_file = f"{csv_prefix}_stats.csv"
    failures_file = f"{csv_prefix}_failures.csv"
    
    if not os.path.exists(stats_file):
        print(f"⚠️  No stats file found: {stats_file}")
        return None
    
    # Load stats
    df = pd.read_csv(stats_file)
    
    # Calculate summary
    summary = {
        "total_requests": df["Request Count"].sum(),
        "total_failures": df["Failure Count"].sum(),
        "error_rate": (df["Failure Count"].sum() / df["Request Count"].sum()) * 100 if df["Request Count"].sum() > 0 else 0,
        "avg_response_time": df["Average Response Time"].mean(),
        "median_response_time": df["Median Response Time"].mean(),
        "p95_response_time": df["95%"].mean(),
        "p99_response_time": df["99%"].mean(),
        "requests_per_sec": df["Requests/s"].sum()
    }
    
    # Load failures if exists
    if os.path.exists(failures_file):
        failures_df = pd.read_csv(failures_file)
        summary["unique_errors"] = len(failures_df)
    else:
        summary["unique_errors"] = 0
    
    return summary


def print_summary(name: str, summary: dict):
    """Print test summary."""
    print(f"\n{'='*60}")
    print(f"{name}")
    print('='*60)
    print(f"Total Requests:      {summary['total_requests']:,}")
    print(f"Total Failures:      {summary['total_failures']:,}")
    print(f"Error Rate:          {summary['error_rate']:.2f}%")
    print(f"Avg Response Time:   {summary['avg_response_time']:.0f}ms")
    print(f"Median Response:     {summary['median_response_time']:.0f}ms")
    print(f"95th Percentile:     {summary['p95_response_time']:.0f}ms")
    print(f"99th Percentile:     {summary['p99_response_time']:.0f}ms")
    print(f"Requests/sec:        {summary['requests_per_sec']:.1f}")
    
    if summary['unique_errors'] > 0:
        print(f"Unique Errors:       {summary['unique_errors']}")
    
    # Pass/Fail checks
    print(f"\n{'Status Checks':}")
    
    checks = []
    
    # Error rate check
    if summary['error_rate'] < 1.0:
        checks.append(("✅", "Error rate < 1%"))
    else:
        checks.append(("❌", f"Error rate too high: {summary['error_rate']:.2f}%"))
    
    # P95 check
    if summary['p95_response_time'] < 2000:
        checks.append(("✅", "P95 response time < 2s"))
    else:
        checks.append(("❌", f"P95 too high: {summary['p95_response_time']:.0f}ms"))
    
    # P99 check
    if summary['p99_response_time'] < 5000:
        checks.append(("✅", "P99 response time < 5s"))
    else:
        checks.append(("❌", f"P99 too high: {summary['p99_response_time']:.0f}ms"))
    
    for status, message in checks:
        print(f"  {status} {message}")


def main():
    parser = argparse.ArgumentParser(description="Analyze load test results")
    parser.add_argument("--report", help="Specific report prefix to analyze (e.g., reports/auth_test)")
    parser.add_argument("--all", action="store_true", help="Analyze all reports")
    
    args = parser.parse_args()
    
    if args.all:
        # Find all CSV files in reports/
        csv_files = glob.glob("reports/*_stats.csv")
        
        if not csv_files:
            print("⚠️  No report files found in reports/ directory")
            return
        
        print("\n" + "="*60)
        print("LOAD TEST RESULTS SUMMARY")
        print("="*60)
        
        for csv_file in sorted(csv_files):
            csv_prefix = csv_file.replace("_stats.csv", "")
            test_name = Path(csv_prefix).stem.replace("_", " ").title()
            
            summary = analyze_csv(csv_prefix)
            if summary:
                print_summary(test_name, summary)
        
        print("\n" + "="*60)
        print("For detailed charts, see HTML reports in reports/ directory")
        print("="*60)
    
    elif args.report:
        csv_prefix = args.report.replace(".html", "").replace("_report", "")
        summary = analyze_csv(csv_prefix)
        if summary:
            test_name = Path(csv_prefix).stem.replace("_", " ").title()
            print_summary(test_name, summary)
    
    else:
        print("Usage:")
        print("  python scripts/analyze_results.py --all")
        print("  python scripts/analyze_results.py --report reports/auth_test")


if __name__ == "__main__":
    main()
