# CPU Profile Analysis

- **Duration**: 37.84s
- **Total Samples**: 29316
- **Active Samples**: 2921 (10.0% CPU utilization)
- **Idle**: 26395 samples (90.0%)
- **Unique Functions**: 389

## Top Functions by Self Time

Self time = time spent IN the function itself, not in functions it calls. These are the actual bottlenecks.

| # | Function | Location | Self Time | Self % |
|---|----------|----------|-----------|--------|
| 1 | `exports.createElement` | .../mobile/index.bundle:1989 | 813.1ms | 2.15% |
| 2 | `exports.jsx` | .../mobile/index.bundle:18155 | 216.8ms | 0.57% |
| 3 | `(garbage collector)` | [native] | 144.6ms | 0.38% |
| 4 | `ReactElement` | .../mobile/index.bundle:1515 | 123.9ms | 0.33% |
| 5 | `Blob` | [native] | 103.3ms | 0.27% |
| 6 | `run` | [native] | 81.3ms | 0.21% |
| 7 | `createTask` | [native] | 65.8ms | 0.17% |
| 8 | `now` | [native] | 62.0ms | 0.16% |
| 9 | `runWithFiberInDEV` | .../mobile/index.bundle:4623 | 54.2ms | 0.14% |
| 10 | `fire` | .../mobile/index.bundle:935119 | 49.0ms | 0.13% |
| 11 | `createWorkInProgress` | .../mobile/index.bundle:5927 | 47.8ms | 0.13% |
| 12 | `postMessage` | [native] | 41.3ms | 0.11% |
| 13 | `createElement` | .../mobile/index.bundle:19114 | 38.7ms | 0.10% |
| 14 | `createDOMProps` | .../mobile/index.bundle:19382 | 37.4ms | 0.10% |
| 15 | `styleq` | .../mobile/index.bundle:23930 | 36.1ms | 0.10% |
| 16 | `_objectWithoutPropertiesLoose` | .../mobile/index.bundle:20339 | 31.0ms | 0.08% |
| 17 | `exports.jsxs` | .../mobile/index.bundle:18159 | 29.7ms | 0.08% |
| 18 | `react-stack-bottom-frame` | .../mobile/index.bundle:16641 | 25.8ms | 0.07% |
| 19 | `i` | .../mobile/index.bundle:508819 | 25.8ms | 0.07% |
| 20 | `attemptEarlyBailoutIfNoScheduledUpdate` | .../mobile/index.bundle:9023 | 24.5ms | 0.06% |

## Hot Lines

Exact source lines where CPU time is spent:

| Function | Location | Line | Ticks | % |
|----------|----------|------|-------|---|
| `exports.createElement` | .../mobile/index.bundle | 2007 | 602 | 2.05% |
| `exports.jsx` | .../mobile/index.bundle | 18158 | 168 | 0.57% |
| `Blob` | [native] | 505076 | 80 | 0.27% |
| `run` | [native] | 4628 | 49 | 0.17% |
| `now` | [native] | 17542 | 44 | 0.15% |
| `createWorkInProgress` | .../mobile/index.bundle | 5928 | 37 | 0.13% |
| `createTask` | [native] | 2007 | 33 | 0.11% |
| `postMessage` | [native] | 17573 | 32 | 0.11% |
| `fire` | .../mobile/index.bundle | 935120 | 32 | 0.11% |
| `exports.createElement` | .../mobile/index.bundle | 1997 | 25 | 0.09% |
| `createElement` | .../mobile/index.bundle | 19122 | 25 | 0.09% |
| `runWithFiberInDEV` | .../mobile/index.bundle | 4628 | 24 | 0.08% |
| `ReactElement` | .../mobile/index.bundle | 1533 | 23 | 0.08% |
| `exports.jsxs` | .../mobile/index.bundle | 18162 | 23 | 0.08% |
| `i` | .../mobile/index.bundle | 508823 | 20 | 0.07% |

## Hot Call Paths

Which function calls are most expensive:

| Caller | Callee | Calls | % |
|--------|--------|-------|---|
| `CssInteropComponent` | `exports.createElement` | 149 | 0.51% |
| `createElement` | `exports.createElement` | 133 | 0.45% |
| `createElement` | `exports.createElement` | 111 | 0.38% |
| `byteLength` | `Blob` | 80 | 0.27% |
| `LocaleProvider` | `exports.createElement` | 56 | 0.19% |
| `(anonymous)` | `exports.jsx` | 52 | 0.18% |
| `Pressable` | `exports.createElement` | 48 | 0.16% |
| `(anonymous)` | `exports.createElement` | 47 | 0.16% |
| `(anonymous)` | `exports.createElement` | 38 | 0.13% |
| `(anonymous)` | `exports.jsx` | 30 | 0.10% |
| `schedulePerformWorkUntilDeadline` | `postMessage` | 26 | 0.09% |
| `runWithFiberInDEV` | `run` | 22 | 0.08% |
| `createElement` | `exports.createElement` | 22 | 0.08% |
| `exports.createElement` | `ReactElement` | 22 | 0.08% |
| `generateCacheKey` | `i` | 20 | 0.07% |

## CPU Time by Category

| Category | Time | % | Top Functions |
|----------|------|---|---------------|
| DOM/Layout | 854.4ms | 22.7% | `exports.createElement`, `createElement`, `__removeChild` |
| Animation | 16.8ms | 0.4% | `shouldAttemptEagerTransition`, `transform`, `AnimatedProps` |
| WebGL/GPU | 9.0ms | 0.2% | `finishRenderingHooks`, `flushMutationEffects`, `flushPassiveEffects` |
| Parsing | 7.7ms | 0.2% | `parser`, `parseTransformProp`, `getFragmentParser` |

## Warnings

- **Deep call stack**: `runWithFiberInDEV` - 2.76s total time with deep recursion/call chains
- **Deep call stack**: `run` - 2.37s total time with deep recursion/call chains
- **Deep call stack**: `createElement` - 606.6ms total time with deep recursion/call chains
- **Single bottleneck**: `exports.createElement` consuming 21.6% of active CPU time

## Call Tree

```
(root) (100.0%)
├─ (idle) (90.0% [self: 90.0%])
├─ performWorkUntilDeadline (7.9% [self: 0.0%]) .../mobile/index.bundle:17432
│  └─ performWorkOnRootViaSchedulerTask (7.6%) .../mobile/index.bundle:11796
│     └─ performWorkOnRoot (7.6% [self: 0.0%]) .../mobile/index.bundle:10821
│        ├─ renderRootSync (6.0% [self: 0.0%]) .../mobile/index.bundle:11040
│        │  └─ performUnitOfWork (5.9% [self: 0.0%]) .../mobile/index.bundle:11205
│        │     └─ runWithFiberInDEV (5.7% [self: 0.1%]) .../mobile/index.bundle:4623
│        │        ├─ run (4.9% [self: 0.1%])
│        │        │  └─ beginWork (4.8% [self: 0.1%]) .../mobile/index.bundle:9078
│        │        │     ├─ updateForwardRef (3.1% [self: 0.0%]) .../mobile/index.bundle:8447
│        │        │     │  └─ renderWithHooks (3.0% [self: 0.0%]) .../mobile/index.bundle:6843
│        │        │     │     └─ react-stack-bottom-frame (3.0% [self: 0.0%]) .../mobile/index.bundle:16641
│        │        │     │        ├─ (anonymous) (1.0% [self: 0.0%]) .../mobile/index.bundle:26136
│        │        │     │        │  └─ createElement (0.7% [self: 0.0%]) .../mobile/index.bundle:19114
│        │        │     │        ├─ (anonymous) (0.9% [self: 0.0%]) .../mobile/index.bundle:37101
│        │        │     │        │  └─ createElement (0.7% [self: 0.0%]) .../mobile/index.bundle:19114
│        │        │     │        │     └─ exports.createElement (0.5% [self: 0.5%]) .../mobile/index.bundle:1989
│        │        │     │        └─ CssInteropComponent (0.7% [self: 0.1%]) .../mobile/index.bundle:18263
│        │        │     │           └─ exports.createElement (0.6% [self: 0.5%]) .../mobile/index.bundle:1989
│        │        │     └─ updateFunctionComponent (1.1% [self: 0.0%]) .../mobile/index.bundle:8539
│        │        │        └─ renderWithHooks (1.1%) .../mobile/index.bundle:6843
│        │        │           └─ react-stack-bottom-frame (1.1% [self: 0.0%]) .../mobile/index.bundle:16641
│        │        └─ beginWork (0.7%) .../mobile/index.bundle:9078
│        └─ renderRootConcurrent (1.5%) .../mobile/index.bundle:11102
│           └─ workLoopConcurrentByScheduler (1.5%) .../mobile/index.bundle:11202
│              └─ performUnitOfWork (1.4%) .../mobile/index.bundle:11205
│                 └─ runWithFiberInDEV (1.4% [self: 0.0%]) .../mobile/index.bundle:4623
│                    └─ run (1.2% [self: 0.0%])
│                       └─ beginWork (1.2%) .../mobile/index.bundle:9078
│                          └─ updateFunctionComponent (1.1%) .../mobile/index.bundle:8539
│                             └─ renderWithHooks (1.1%) .../mobile/index.bundle:6843
│                                └─ react-stack-bottom-frame (1.1%) .../mobile/index.bundle:16641
│                                   └─ Ze (1.1%) .../mobile/index.bundle:508862
│                                      └─ parse (0.9% [self: 0.0%]) .../mobile/index.bundle:551336
│                                         └─ parser (0.9% [self: 0.0%]) .../mobile/index.bundle:544076
│                                            └─ fromMarkdown (0.9% [self: 0.0%]) .../mobile/index.bundle:544183
└─ (program) (1.0% [self: 1.0%])
```

## Activity Timeline

```
     0ms |                                        |   0% (program)           
  2531ms |                                        |   0% (idle)              
  4365ms |                                        |   0% (idle)              
  6361ms |                                        |   1% exports.createElemen
  8234ms |#########                               |  23% exports.createElemen
 10075ms |########                                |  19% exports.createElemen
 11900ms |########                                |  19% exports.createElemen
 13753ms |########                                |  20% exports.createElemen
 15590ms |#########                               |  22% exports.createElemen
 17414ms |#########                               |  23% exports.createElemen
 19255ms |########                                |  20% exports.createElemen
 21088ms |#########                               |  21% exports.createElemen
 22920ms |#########                               |  24% exports.createElemen
 24769ms |##                                      |   5% exports.createElemen
 26597ms |                                        |   0% (program)           
 28429ms |                                        |   0% (idle)              
 30257ms |                                        |   0% (idle)              
 32093ms |#                                       |   3% (garbage collector) 
 33923ms |                                        |   0% (idle)              
 35755ms |                                        |   0% (idle)              
 37817ms |                                        |   0% (idle)              
```