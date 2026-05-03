# CPU Profile Analysis

- **Duration**: 22.62s
- **Total Samples**: 17472
- **Active Samples**: 5340 (30.6% CPU utilization)
- **Idle**: 12132 samples (69.4%)
- **Unique Functions**: 252

## Top Functions by Self Time

Self time = time spent IN the function itself, not in functions it calls. These are the actual bottlenecks.

| # | Function | Location | Self Time | Self % |
|---|----------|----------|-----------|--------|
| 1 | `exports.createElement` | .../mobile/index.bundle:1989 | 264.1ms | 1.17% |
| 2 | `exports.jsx` | .../mobile/index.bundle:18155 | 120.4ms | 0.53% |
| 3 | `(garbage collector)` | [native] | 76.4ms | 0.34% |
| 4 | `Blob` | [native] | 37.5ms | 0.17% |
| 5 | `now` | [native] | 31.1ms | 0.14% |
| 6 | `performUnitOfWork` | .../mobile/index.bundle:11205 | 28.5ms | 0.13% |
| 7 | `run` | [native] | 28.5ms | 0.13% |
| 8 | `createTask` | [native] | 28.5ms | 0.13% |
| 9 | `update` | .../mobile/index.bundle:30744 | 23.3ms | 0.10% |
| 10 | `createElement` | .../mobile/index.bundle:19114 | 18.1ms | 0.08% |
| 11 | `CssInteropComponent` | .../mobile/index.bundle:18263 | 18.1ms | 0.08% |
| 12 | `reconcileChildFibersImpl` | .../mobile/index.bundle:8089 | 18.1ms | 0.08% |
| 13 | `main` | .../mobile/index.bundle:547650 | 16.8ms | 0.07% |
| 14 | `beginWork` | .../mobile/index.bundle:9078 | 15.5ms | 0.07% |
| 15 | `createDOMProps` | .../mobile/index.bundle:19382 | 15.5ms | 0.07% |
| 16 | `mapIntoArray` | .../mobile/index.bundle:1600 | 15.5ms | 0.07% |
| 17 | `validateProperty` | .../mobile/index.bundle:5297 | 14.2ms | 0.06% |
| 18 | `renderWithHooks` | .../mobile/index.bundle:6843 | 11.6ms | 0.05% |
| 19 | `(anonymous)` | .../mobile/index.bundle:26136 | 11.6ms | 0.05% |
| 20 | `(anonymous)` | .../mobile/index.bundle:935103 | 11.6ms | 0.05% |

## Hot Lines

Exact source lines where CPU time is spent:

| Function | Location | Line | Ticks | % |
|----------|----------|------|-------|---|
| `exports.createElement` | .../mobile/index.bundle | 1990 | 204 | 1.17% |
| `exports.jsx` | .../mobile/index.bundle | 18156 | 90 | 0.52% |
| `Blob` | [native] | 505076 | 29 | 0.17% |
| `performUnitOfWork` | .../mobile/index.bundle | 11206 | 22 | 0.13% |
| `now` | [native] | 11206 | 16 | 0.09% |
| `update` | .../mobile/index.bundle | 30766 | 15 | 0.09% |
| `createElement` | .../mobile/index.bundle | 19115 | 14 | 0.08% |
| `CssInteropComponent` | .../mobile/index.bundle | 18264 | 14 | 0.08% |
| `reconcileChildFibersImpl` | .../mobile/index.bundle | 8090 | 14 | 0.08% |
| `run` | [native] | 11206 | 13 | 0.07% |
| `createTask` | [native] | 1990 | 13 | 0.07% |
| `main` | .../mobile/index.bundle | 547651 | 13 | 0.07% |
| `beginWork` | .../mobile/index.bundle | 9079 | 12 | 0.07% |
| `createDOMProps` | .../mobile/index.bundle | 19383 | 12 | 0.07% |
| `mapIntoArray` | .../mobile/index.bundle | 1601 | 12 | 0.07% |

## Hot Call Paths

Which function calls are most expensive:

| Caller | Callee | Calls | % |
|--------|--------|-------|---|
| `CssInteropComponent` | `exports.createElement` | 60 | 0.34% |
| `createElement` | `exports.createElement` | 51 | 0.29% |
| `byteLength` | `Blob` | 29 | 0.17% |
| `createElement` | `exports.createElement` | 28 | 0.16% |
| `(anonymous)` | `exports.jsx` | 25 | 0.14% |
| `(anonymous)` | `exports.createElement` | 21 | 0.12% |
| `(anonymous)` | `exports.jsx` | 18 | 0.10% |
| `handleResize` | `update` | 18 | 0.10% |
| `workLoopSync` | `performUnitOfWork` | 17 | 0.10% |
| `Pressable` | `exports.createElement` | 16 | 0.09% |
| `renderWithHooks` | `CssInteropComponent` | 14 | 0.08% |
| `performUnitOfWork` | `run` | 13 | 0.07% |
| `(anonymous)` | `createElement` | 11 | 0.06% |
| `(anonymous)` | `exports.jsx` | 11 | 0.06% |
| `performUnitOfWork` | `now` | 10 | 0.06% |

## CPU Time by Category

| Category | Time | % | Top Functions |
|----------|------|---|---------------|
| DOM/Layout | 284.8ms | 4.1% | `exports.createElement`, `createElement`, `setTextContent` |
| WebGL/GPU | 6.5ms | 0.1% | `bailoutOnAlreadyFinishedWork`, `flushSpawnedWork`, `flushMutationEffects` |
| Animation | 5.2ms | 0.1% | `useAnimatedProps`, `AnimatedProps` |
| Parsing | 2.6ms | 0.0% | `fromParse5`, `getFragmentParser` |

## Call Tree

```
(root) (100.0%)
├─ (idle) (69.4% [self: 69.4%])
├─ (program) (25.2% [self: 25.2%])
└─ performWorkUntilDeadline (4.5% [self: 0.0%]) .../mobile/index.bundle:17432
   └─ performWorkOnRootViaSchedulerTask (4.3%) .../mobile/index.bundle:11796
      └─ performWorkOnRoot (4.3%) .../mobile/index.bundle:10821
         ├─ renderRootSync (3.3%) .../mobile/index.bundle:11040
         │  └─ workLoopSync (3.3%) .../mobile/index.bundle:11099
         │     └─ performUnitOfWork (3.3% [self: 0.1%]) .../mobile/index.bundle:11205
         │        └─ run (2.7% [self: 0.1%])
         │           └─ beginWork (2.6% [self: 0.1%]) .../mobile/index.bundle:9078
         │              ├─ updateForwardRef (1.7% [self: 0.0%]) .../mobile/index.bundle:8447
         │              │  └─ renderWithHooks (1.6% [self: 0.0%]) .../mobile/index.bundle:6843
         │              └─ updateFunctionComponent (0.6%) .../mobile/index.bundle:8539
         │                 └─ renderWithHooks (0.6% [self: 0.0%]) .../mobile/index.bundle:6843
         └─ renderRootConcurrent (0.7%) .../mobile/index.bundle:11102
            └─ workLoopConcurrentByScheduler (0.7%) .../mobile/index.bundle:11202
               └─ performUnitOfWork (0.7% [self: 0.0%]) .../mobile/index.bundle:11205
                  └─ run (0.5% [self: 0.0%])
                     └─ beginWork (0.5% [self: 0.0%]) .../mobile/index.bundle:9078
```

## Activity Timeline

```
     0ms |####################                    |  49% (program)           
  1807ms |################                        |  39% (program)           
  2897ms |####################                    |  50% (program)           
  4045ms |#####################                   |  52% (program)           
  5136ms |#################                       |  42% (program)           
  6225ms |##########                              |  25% (program)           
  7317ms |#########                               |  23% (program)           
  8408ms |##########                              |  26% (program)           
  9513ms |#########                               |  23% (program)           
 10602ms |#########                               |  23% (program)           
 11693ms |#########                               |  24% (program)           
 12786ms |##########                              |  24% (program)           
 13876ms |##########                              |  24% (program)           
 14966ms |#########                               |  23% (program)           
 16057ms |##########                              |  24% (program)           
 17146ms |#########                               |  23% (program)           
 18235ms |############                            |  29% (program)           
 19323ms |############                            |  29% (program)           
 20409ms |###########                             |  28% (program)           
 21509ms |############                            |  29% (program)           
 22600ms |#############                           |  33% (program)           
```