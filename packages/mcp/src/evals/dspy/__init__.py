"""
DSPy Optimization Module for Shogo Agent

This module provides DSPy-based prompt optimization capabilities:
- signatures.py: DSPy signatures defining agent behavior
- dataset.py: Training and test datasets
- metrics.py: Evaluation metrics for optimization
- optimize.py: Main optimization script
- export.py: Export optimized prompts to TypeScript

Usage:
    # Run optimization
    python -m packages.mcp.src.evals.dspy.optimize --strategy mipro
    
    # Export results
    python -m packages.mcp.src.evals.dspy.export --input results/optimized_agent.json
"""

from .signatures import TemplateSelection, ShogoTemplateAgent, TemplateSelector
from .dataset import create_trainset, create_testset, split_dataset
from .metrics import (
    template_accuracy,
    no_unnecessary_clarification,
    reasoning_quality,
    combined_metric,
    AgentMetrics,
)

__all__ = [
    # Signatures
    'TemplateSelection',
    'ShogoTemplateAgent', 
    'TemplateSelector',
    # Dataset
    'create_trainset',
    'create_testset',
    'split_dataset',
    # Metrics
    'template_accuracy',
    'no_unnecessary_clarification',
    'reasoning_quality',
    'combined_metric',
    'AgentMetrics',
]
