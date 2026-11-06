| Operation | Scale | n (B/A) | Before p50 | Before p95 | After p50 | After p95 | After/before p50 (95% CI) | Holm p | Result |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| `boot.runningTurns` | 1x | 30/30 | 0.078 ms | 0.086 ms | 0.006 ms | 0.012 ms | 0.081 (0.075-0.086) | <1e-6 | **faster** |
| `boot.runningTurns` | 10x | 30/30 | 1.92 ms | 7.99 ms | 0.014 ms | 0.065 ms | 0.007 (0.003-0.019) | <1e-6 | **faster** |
| `boot.runningTurns` | 100x | 30/30 | 18.8 ms | 46.0 ms | 0.033 ms | 0.078 ms | 0.002 (0.000-0.003) | <1e-6 | **faster** |
| `boot.runningTurns` | 1000x | 30/30 | 210 ms | 344 ms | 0.075 ms | 0.107 ms | 0.000 (0.000-0.000) | <1e-6 | **faster** |
| `chat.fullSnapshot` | 1x | 30/30 | 0.805 ms | 2.45 ms | 0.807 ms | 2.03 ms | 1.003 (0.965-1.036) | 1.0 | no change |
| `chat.fullSnapshot` | 10x | 30/30 | 3.98 ms | 7.54 ms | 4.05 ms | 8.06 ms | 1.016 (0.969-1.081) | 1.0 | no change |
| `chat.fullSnapshot` | 100x | 30/30 | 21.6 ms | 26.5 ms | 21.7 ms | 26.9 ms | 1.005 (0.914-1.085) | 1.0 | no change |
| `chat.fullSnapshot` | 1000x | 30/30 | 135 ms | 228 ms | 129 ms | 163 ms | 0.952 (0.842-1.033) | 1.0 | no change |
| `chat.jumpToMessage` | 1x | 30/30 | 0.488 ms | 0.625 ms | 0.499 ms | 0.834 ms | 1.022 (0.972-1.140) | 1.0 | no change |
| `chat.jumpToMessage` | 10x | 30/30 | 0.527 ms | 0.680 ms | 0.516 ms | 0.625 ms | 0.978 (0.934-1.039) | 1.0 | no change |
| `chat.jumpToMessage` | 100x | 30/30 | 0.911 ms | 3.48 ms | 0.810 ms | 2.72 ms | 0.890 (0.765-1.072) | 1.0 | no change |
| `chat.jumpToMessage` | 1000x | 30/30 | 2.36 ms | 2.75 ms | 2.31 ms | 2.89 ms | 0.979 (0.929-1.132) | 1.0 | no change |
| `chat.openLatestPage` | 1x | 30/30 | 0.347 ms | 0.432 ms | 0.343 ms | 0.387 ms | 0.990 (0.956-1.018) | 1.0 | no change |
| `chat.openLatestPage` | 10x | 30/30 | 0.458 ms | 0.717 ms | 0.458 ms | 0.590 ms | 0.999 (0.904-1.069) | 1.0 | no change |
| `chat.openLatestPage` | 100x | 30/30 | 1.00 ms | 1.31 ms | 0.942 ms | 1.25 ms | 0.942 (0.892-1.037) | 1.0 | no change |
| `chat.openLatestPage` | 1000x | 30/30 | 4.17 ms | 4.83 ms | 4.35 ms | 4.86 ms | 1.044 (0.961-1.084) | 1.0 | no change |
| `chat.recoveryMessages` | 1x | 30/30 | 0.332 ms | 0.586 ms | 0.336 ms | 0.415 ms | 1.012 (1.004-1.019) | 0.82 | no change |
| `chat.recoveryMessages` | 10x | 30/30 | 2.03 ms | 2.29 ms | 1.93 ms | 2.25 ms | 0.947 (0.908-1.012) | 1.0 | no change |
| `chat.recoveryMessages` | 100x | 30/30 | 10.2 ms | 21.6 ms | 10.8 ms | 13.6 ms | 1.060 (1.006-1.127) | 1.0 | no change |
| `chat.recoveryMessages` | 1000x | 30/30 | 51.7 ms | 175 ms | 50.8 ms | 80.5 ms | 0.984 (0.810-1.143) | 1.0 | no change |
| `chat.runtime` | 1x | 30/30 | 0.032 ms | 0.038 ms | 0.031 ms | 0.035 ms | 0.989 (0.940-1.030) | 1.0 | no change |
| `chat.runtime` | 10x | 30/30 | 0.031 ms | 0.033 ms | 0.032 ms | 0.035 ms | 1.054 (1.030-1.072) | 0.12 | no change |
| `chat.runtime` | 100x | 30/30 | 0.033 ms | 0.065 ms | 0.033 ms | 0.770 ms | 0.998 (0.955-1.033) | 1.0 | no change |
| `chat.runtime` | 1000x | 30/30 | 0.033 ms | 0.043 ms | 0.032 ms | 0.041 ms | 0.950 (0.883-1.011) | 1.0 | no change |
| `chat.scrollOlderPage` | 1x | 30/30 | 0.345 ms | 0.422 ms | 0.353 ms | 0.567 ms | 1.022 (0.992-1.068) | 1.0 | no change |
| `chat.scrollOlderPage` | 10x | 30/30 | 0.400 ms | 0.585 ms | 0.392 ms | 0.682 ms | 0.980 (0.962-1.057) | 1.0 | no change |
| `chat.scrollOlderPage` | 100x | 30/30 | 0.608 ms | 0.866 ms | 0.607 ms | 0.723 ms | 0.997 (0.953-1.045) | 1.0 | no change |
| `chat.scrollOlderPage` | 1000x | 30/30 | 2.18 ms | 2.71 ms | 2.14 ms | 2.79 ms | 0.980 (0.915-1.097) | 1.0 | no change |
| `chat.turnAnswer` | 1x | 30/30 | 0.074 ms | 0.128 ms | 0.026 ms | 0.034 ms | 0.352 (0.341-0.357) | <1e-6 | **faster** |
| `chat.turnAnswer` | 10x | 30/30 | 0.630 ms | 0.821 ms | 0.032 ms | 0.078 ms | 0.051 (0.042-0.062) | <1e-6 | **faster** |
| `chat.turnAnswer` | 100x | 30/30 | 3.79 ms | 7.88 ms | 0.062 ms | 0.145 ms | 0.016 (0.010-0.029) | <1e-6 | **faster** |
| `chat.turnAnswer` | 1000x | 30/30 | 17.8 ms | 37.2 ms | 0.095 ms | 0.153 ms | 0.005 (0.003-0.007) | <1e-6 | **faster** |
| `events.hasAggregate` | 1x | 30/30 | 0.010 ms | 0.016 ms | 0.010 ms | 0.017 ms | 1.011 (0.965-1.050) | 1.0 | no change |
| `events.hasAggregate` | 10x | 30/30 | 0.010 ms | 0.019 ms | 0.010 ms | 0.012 ms | 0.985 (0.933-1.015) | 1.0 | no change |
| `events.hasAggregate` | 100x | 30/30 | 0.009 ms | 0.010 ms | 0.009 ms | 0.010 ms | 1.002 (0.987-1.018) | 1.0 | no change |
| `events.hasAggregate` | 1000x | 30/30 | 0.011 ms | 0.026 ms | 0.011 ms | 0.059 ms | 1.051 (0.961-1.178) | 1.0 | no change |
| `memory.list` | 1x | 30/30 | 0.047 ms | 0.060 ms | 0.049 ms | 0.089 ms | 1.026 (0.971-1.170) | 1.0 | no change |
| `memory.list` | 10x | 30/30 | 0.194 ms | 0.323 ms | 0.192 ms | 0.593 ms | 0.987 (0.928-1.039) | 1.0 | no change |
| `memory.list` | 100x | 30/30 | 0.609 ms | 0.857 ms | 0.592 ms | 0.912 ms | 0.973 (0.914-1.082) | 1.0 | no change |
| `memory.list` | 1000x | 30/30 | 0.651 ms | 0.703 ms | 0.647 ms | 0.746 ms | 0.994 (0.935-1.088) | 1.0 | no change |
| `memory.listPage` | 1x | 30/30 | 1.63 ms | 2.06 ms | 0.922 ms | 1.17 ms | 0.567 (0.522-0.620) | <1e-6 | **faster** |
| `memory.listPage` | 10x | 30/30 | 4.38 ms | 6.20 ms | 0.802 ms | 2.00 ms | 0.183 (0.171-0.198) | <1e-6 | **faster** |
| `memory.listPage` | 100x | 30/30 | 17.0 ms | 40.1 ms | 0.851 ms | 1.62 ms | 0.050 (0.040-0.055) | <1e-6 | **faster** |
| `memory.listPage` | 1000x | 30/30 | 14.7 ms | 16.4 ms | 0.808 ms | 0.948 ms | 0.055 (0.053-0.057) | <1e-6 | **faster** |
| `memory.search` | 1x | 30/30 | 0.457 ms | 0.707 ms | 0.288 ms | 0.504 ms | 0.631 (0.551-0.722) | 0.0000049 | **faster** |
| `memory.search` | 10x | 30/30 | 1.35 ms | 2.30 ms | 0.578 ms | 0.864 ms | 0.428 (0.385-0.489) | <1e-6 | **faster** |
| `memory.search` | 100x | 30/30 | 6.87 ms | 17.5 ms | 4.10 ms | 19.5 ms | 0.597 (0.445-0.801) | 0.0011 | **faster** |
| `memory.search` | 1000x | 30/30 | 8.41 ms | 9.12 ms | 5.77 ms | 6.27 ms | 0.686 (0.652-0.708) | <1e-6 | **faster** |
| `memory.selectionState` | 1x | 30/30 | 0.091 ms | 0.135 ms | 0.099 ms | 0.128 ms | 1.090 (1.046-1.135) | 0.0054 | slower |
| `memory.selectionState` | 10x | 30/30 | 0.331 ms | 0.885 ms | 0.363 ms | 1.34 ms | 1.094 (0.995-1.260) | 0.37 | no change |
| `memory.selectionState` | 100x | 30/30 | 1.33 ms | 3.28 ms | 1.29 ms | 2.89 ms | 0.969 (0.852-1.196) | 1.0 | no change |
| `memory.selectionState` | 1000x | 30/30 | 1.12 ms | 1.33 ms | 1.17 ms | 1.45 ms | 1.045 (1.012-1.113) | 1.0 | no change |
| `memory.setInclusions` | 1x | 30/30 | 0.744 ms | 1.76 ms | 0.416 ms | 1.52 ms | 0.559 (0.488-0.704) | 0.00085 | **faster** |
| `memory.setInclusions` | 10x | 30/30 | 2.54 ms | 6.17 ms | 0.929 ms | 3.01 ms | 0.366 (0.313-0.402) | 0.0000020 | **faster** |
| `memory.setInclusions` | 100x | 30/30 | 10.2 ms | 17.3 ms | 3.09 ms | 5.39 ms | 0.305 (0.273-0.339) | <1e-6 | **faster** |
| `memory.setInclusions` | 1000x | 30/30 | 8.37 ms | 12.7 ms | 2.88 ms | 4.29 ms | 0.345 (0.273-0.416) | <1e-6 | **faster** |
| `routines.due` | 1x | 30/30 | 0.021 ms | 0.029 ms | 0.022 ms | 0.025 ms | 1.030 (0.959-1.110) | 1.0 | no change |
| `routines.due` | 10x | 30/30 | 0.020 ms | 0.029 ms | 0.019 ms | 0.033 ms | 0.971 (0.941-1.000) | 1.0 | no change |
| `routines.due` | 100x | 30/30 | 0.019 ms | 0.031 ms | 0.021 ms | 0.034 ms | 1.094 (1.025-1.241) | 0.20 | no change |
| `routines.due` | 1000x | 30/30 | 0.026 ms | 0.058 ms | 0.022 ms | 0.045 ms | 0.847 (0.726-0.907) | 0.0086 | **faster** |
| `routines.list` | 1x | 30/30 | 0.045 ms | 0.055 ms | 0.043 ms | 0.052 ms | 0.967 (0.916-1.036) | 1.0 | no change |
| `routines.list` | 10x | 30/30 | 0.068 ms | 0.076 ms | 0.067 ms | 0.080 ms | 0.996 (0.953-1.041) | 1.0 | no change |
| `routines.list` | 100x | 30/30 | 0.146 ms | 0.321 ms | 0.141 ms | 0.244 ms | 0.962 (0.895-1.063) | 1.0 | no change |
| `routines.list` | 1000x | 30/30 | 0.295 ms | 0.573 ms | 0.283 ms | 0.368 ms | 0.958 (0.847-1.054) | 1.0 | no change |
| `routines.pendingRuns` | 1x | 30/30 | 0.017 ms | 0.020 ms | 0.016 ms | 0.020 ms | 0.942 (0.886-1.016) | 1.0 | no change |
| `routines.pendingRuns` | 10x | 30/30 | 0.017 ms | 0.019 ms | 0.017 ms | 0.021 ms | 0.976 (0.933-1.056) | 1.0 | no change |
| `routines.pendingRuns` | 100x | 30/30 | 0.023 ms | 0.039 ms | 0.022 ms | 0.085 ms | 0.978 (0.896-1.090) | 1.0 | no change |
| `routines.pendingRuns` | 1000x | 30/30 | 0.034 ms | 0.040 ms | 0.034 ms | 0.043 ms | 0.986 (0.934-1.064) | 1.0 | no change |
| `routines.runs` | 1x | 30/30 | 0.150 ms | 0.296 ms | 0.156 ms | 0.339 ms | 1.037 (0.759-1.102) | 1.0 | no change |
| `routines.runs` | 10x | 30/30 | 0.221 ms | 0.235 ms | 0.224 ms | 0.239 ms | 1.013 (0.988-1.024) | 1.0 | no change |
| `routines.runs` | 100x | 30/30 | 0.227 ms | 0.311 ms | 0.229 ms | 0.301 ms | 1.009 (0.986-1.053) | 1.0 | no change |
| `routines.runs` | 1000x | 30/30 | 0.233 ms | 0.338 ms | 0.232 ms | 0.418 ms | 0.996 (0.908-1.112) | 1.0 | no change |
| `search.files` | 1x | 30/30 | 0.239 ms | 0.396 ms | 0.241 ms | 0.343 ms | 1.011 (0.932-1.090) | 1.0 | no change |
| `search.files` | 10x | 30/30 | 2.47 ms | 3.92 ms | 2.58 ms | 3.41 ms | 1.043 (0.961-1.131) | 1.0 | no change |
| `search.files` | 100x | 30/30 | 23.6 ms | 45.9 ms | 22.7 ms | 36.2 ms | 0.960 (0.760-1.198) | 1.0 | no change |
| `search.files` | 1000x | 30/30 | 179 ms | 250 ms | 187 ms | 267 ms | 1.045 (0.816-1.243) | 1.0 | no change |
| `search.messagesAgent` | 1x | 30/30 | 9.03 ms | 12.4 ms | 8.69 ms | 13.7 ms | 0.962 (0.896-1.031) | 1.0 | no change |
| `search.messagesAgent` | 10x | 30/30 | 86.6 ms | 188 ms | 88.6 ms | 162 ms | 1.023 (0.747-1.318) | 1.0 | no change |
| `search.messagesAgent` | 100x | 30/30 | 983 ms | 4.11 s | 880 ms | 1.25 s | 0.896 (0.631-1.043) | 0.72 | no change |
| `search.messagesAll` | 1x | 30/30 | 9.56 ms | 16.0 ms | 10.1 ms | 11.7 ms | 1.054 (0.961-1.084) | 1.0 | no change |
| `search.messagesAll` | 10x | 30/30 | 138 ms | 353 ms | 104 ms | 273 ms | 0.754 (0.500-1.125) | 1.0 | no change |
| `search.messagesAll` | 100x | 30/30 | 1.01 s | 3.69 s | 972 ms | 1.58 s | 0.961 (0.882-1.069) | 1.0 | no change |
| `sidebar.listAgents` | 1x | 30/30 | 0.016 ms | 0.022 ms | 0.016 ms | 0.022 ms | 1.025 (0.958-1.108) | 1.0 | no change |
| `sidebar.listAgents` | 10x | 30/30 | 0.028 ms | 0.030 ms | 0.027 ms | 0.030 ms | 0.994 (0.971-1.031) | 1.0 | no change |
| `sidebar.listAgents` | 100x | 30/30 | 0.049 ms | 0.052 ms | 0.048 ms | 0.050 ms | 0.994 (0.987-1.006) | 1.0 | no change |
| `sidebar.listAgents` | 1000x | 30/30 | 0.100 ms | 0.211 ms | 0.098 ms | 0.156 ms | 0.985 (0.947-1.009) | 1.0 | no change |
| `sidebar.openSideThreads` | 1x | 30/30 | 0.018 ms | 0.025 ms | 0.017 ms | 0.023 ms | 0.992 (0.962-1.143) | 1.0 | no change |
| `sidebar.openSideThreads` | 10x | 30/30 | 0.067 ms | 0.102 ms | 0.066 ms | 0.088 ms | 0.988 (0.954-1.025) | 1.0 | no change |
| `sidebar.openSideThreads` | 100x | 30/30 | 0.306 ms | 0.489 ms | 0.308 ms | 0.467 ms | 1.006 (0.943-1.104) | 1.0 | no change |
| `sidebar.openSideThreads` | 1000x | 30/30 | 1.51 ms | 1.79 ms | 1.47 ms | 1.87 ms | 0.972 (0.899-1.083) | 1.0 | no change |
| `sidebar.sideThreads` | 1x | 30/30 | 0.043 ms | 0.056 ms | 0.044 ms | 0.055 ms | 1.019 (0.987-1.081) | 1.0 | no change |
| `sidebar.sideThreads` | 10x | 30/30 | 0.056 ms | 0.075 ms | 0.054 ms | 0.063 ms | 0.980 (0.952-1.006) | 1.0 | no change |
| `sidebar.sideThreads` | 100x | 30/30 | 0.092 ms | 0.127 ms | 0.092 ms | 0.117 ms | 1.004 (0.951-1.039) | 1.0 | no change |
| `sidebar.sideThreads` | 1000x | 30/30 | 0.162 ms | 0.208 ms | 0.166 ms | 0.355 ms | 1.021 (0.954-1.089) | 1.0 | no change |
| `sidebar.unreadNeverRead` | 1x | 30/30 | 1.93 ms | 2.80 ms | 1.98 ms | 4.66 ms | 1.028 (0.984-1.139) | 1.0 | no change |
| `sidebar.unreadNeverRead` | 10x | 30/30 | 18.7 ms | 38.0 ms | 19.3 ms | 33.1 ms | 1.033 (0.882-1.155) | 1.0 | no change |
| `sidebar.unreadNeverRead` | 100x | 30/30 | 303 ms | 472 ms | 297 ms | 463 ms | 0.980 (0.648-1.359) | 1.0 | no change |
| `sidebar.unreadStates` | 1x | 30/30 | 1.07 ms | 1.36 ms | 1.06 ms | 1.37 ms | 0.992 (0.964-1.021) | 1.0 | no change |
| `sidebar.unreadStates` | 10x | 30/30 | 2.35 ms | 4.09 ms | 2.38 ms | 4.65 ms | 1.009 (0.939-1.125) | 1.0 | no change |
| `sidebar.unreadStates` | 100x | 30/30 | 6.55 ms | 20.6 ms | 6.70 ms | 50.9 ms | 1.022 (0.801-1.393) | 1.0 | no change |
| `sidebar.unreadStates` | 1000x | 30/30 | 12.0 ms | 14.0 ms | 12.3 ms | 14.7 ms | 1.025 (0.944-1.098) | 1.0 | no change |
| `stats.sentMessages` | 1x | 30/30 | 0.303 ms | 0.328 ms | 0.305 ms | 0.379 ms | 1.010 (0.986-1.049) | 1.0 | no change |
| `stats.sentMessages` | 10x | 30/30 | 5.20 ms | 5.60 ms | 5.20 ms | 6.86 ms | 1.000 (0.963-1.057) | 1.0 | no change |
| `stats.sentMessages` | 100x | 30/30 | 68.1 ms | 154 ms | 57.0 ms | 117 ms | 0.837 (0.611-1.222) | 1.0 | no change |
| `tables.list` | 1x | 30/30 | 0.775 ms | 1.63 ms | 0.806 ms | 1.57 ms | 1.040 (0.758-1.260) | 1.0 | no change |
| `tables.list` | 10x | 30/30 | 1.28 ms | 2.93 ms | 1.25 ms | 3.82 ms | 0.976 (0.661-1.286) | 1.0 | no change |
| `tables.list` | 100x | 30/30 | 6.88 ms | 19.5 ms | 7.16 ms | 13.9 ms | 1.040 (0.824-1.219) | 1.0 | no change |
| `tables.list` | 1000x | 30/30 | 32.4 ms | 34.8 ms | 32.4 ms | 36.4 ms | 1.000 (0.985-1.019) | 1.0 | no change |
| `tables.query` | 1x | 30/30 | 0.371 ms | 0.951 ms | 0.341 ms | 2.08 ms | 0.921 (0.676-1.099) | 1.0 | no change |
| `tables.query` | 10x | 30/30 | 0.453 ms | 0.605 ms | 0.465 ms | 0.546 ms | 1.026 (0.942-1.123) | 1.0 | no change |
| `tables.query` | 100x | 30/30 | 3.11 ms | 4.45 ms | 3.02 ms | 6.48 ms | 0.972 (0.870-1.123) | 1.0 | no change |
| `tables.query` | 1000x | 30/30 | 18.6 ms | 21.0 ms | 18.8 ms | 24.9 ms | 1.012 (0.972-1.048) | 1.0 | no change |
| `write.appendMessage` | 1x | 30/30 | 0.288 ms | 0.519 ms | 0.301 ms | 0.563 ms | 1.048 (0.868-1.295) | 1.0 | no change |
| `write.appendMessage` | 10x | 30/30 | 0.339 ms | 0.475 ms | 0.362 ms | 0.621 ms | 1.068 (0.897-1.201) | 1.0 | no change |
| `write.appendMessage` | 100x | 30/30 | 0.748 ms | 6.26 ms | 0.785 ms | 2.73 ms | 1.050 (0.926-1.359) | 1.0 | no change |
| `write.appendMessage` | 1000x | 30/30 | 2.85 ms | 3.51 ms | 2.91 ms | 3.42 ms | 1.022 (0.941-1.091) | 1.0 | no change |
| `write.deleteSideThread` | 1x | 30/30 | 2.70 ms | 3.58 ms | 1.81 ms | 4.10 ms | 0.672 (0.604-0.743) | 0.00017 | **faster** |
| `write.deleteSideThread` | 10x | 30/30 | 21.5 ms | 46.5 ms | 2.67 ms | 6.39 ms | 0.124 (0.101-0.158) | <1e-6 | **faster** |
| `write.deleteSideThread` | 100x | 30/30 | 225 ms | 299 ms | 4.01 ms | 14.2 ms | 0.018 (0.015-0.023) | <1e-6 | **faster** |
| `write.deleteSideThread` | 1000x | 30/30 | 1.42 s | 26.85 s | 5.88 ms | 13.2 ms | 0.004 (0.004-0.004) | <1e-6 | **faster** |
| `write.snapshotPersist` | 1x | 30/30 | 1.70 ms | 2.11 ms | 1.33 ms | 1.87 ms | 0.783 (0.719-0.847) | 0.000054 | **faster** |
| `write.snapshotPersist` | 10x | 30/30 | 9.31 ms | 10.8 ms | 2.72 ms | 3.82 ms | 0.292 (0.280-0.313) | <1e-6 | **faster** |
| `write.snapshotPersist` | 100x | 30/30 | 98.8 ms | 210 ms | 8.47 ms | 17.0 ms | 0.086 (0.056-0.113) | <1e-6 | **faster** |
| `write.snapshotPersist` | 1000x | 30/30 | 528 ms | 736 ms | 10.7 ms | 23.8 ms | 0.020 (0.019-0.021) | <1e-6 | **faster** |
| `write.streamFlush` | 1x | 30/30 | 0.166 ms | 0.249 ms | 0.171 ms | 0.252 ms | 1.032 (0.945-1.116) | 1.0 | no change |
| `write.streamFlush` | 10x | 30/30 | 0.221 ms | 0.308 ms | 0.198 ms | 0.339 ms | 0.896 (0.800-1.051) | 1.0 | no change |
| `write.streamFlush` | 100x | 30/30 | 0.235 ms | 1.91 ms | 0.259 ms | 2.62 ms | 1.103 (0.770-1.553) | 1.0 | no change |
| `write.streamFlush` | 1000x | 30/30 | 0.259 ms | 0.445 ms | 0.254 ms | 0.413 ms | 0.983 (0.888-1.078) | 1.0 | no change |

| Scale | DB file | Open before (schema) | Open after, with the upgrade (schema) |
|---:|---:|---:|---:|
| 1x | 15 MiB | 9.94 ms (v58) | 28.9 ms (v59) |
| 10x | 145 MiB | 2.74 ms (v58) | 344 ms (v59) |
| 100x | 1442 MiB | 1.78 ms (v58) | 3.94 s (v59) |
| 1000x | 14552 MiB | 13.9 ms (v58) | 316.39 s (v59) |


| Operation | 1x p50 / p95 | 10x p50 / p95 | 100x p50 / p95 | 1000x p50 / p95 | Full scans flagged at the largest scale |
|---|---:|---:|---:|---:|---|
| `sidebar.listAgents` | 0.016 ms / 0.022 ms | 0.028 ms / 0.030 ms | 0.049 ms / 0.052 ms | 0.100 ms / 0.211 ms |  |
| `sidebar.unreadStates` | 1.07 ms / 1.36 ms | 2.35 ms / 4.09 ms | 6.55 ms / 20.6 ms | 12.0 ms / 14.0 ms |  |
| `sidebar.unreadNeverRead` | 1.93 ms / 2.80 ms | 18.7 ms / 38.0 ms | 303 ms / 472 ms | 3.26 s / 15.30 s |  |
| `sidebar.sideThreads` | 0.043 ms / 0.056 ms | 0.056 ms / 0.075 ms | 0.092 ms / 0.127 ms | 0.162 ms / 0.208 ms |  |
| `sidebar.openSideThreads` | 0.018 ms / 0.025 ms | 0.067 ms / 0.102 ms | 0.306 ms / 0.489 ms | 1.51 ms / 1.79 ms |  |
| `chat.openLatestPage` | 0.347 ms / 0.432 ms | 0.458 ms / 0.717 ms | 1.00 ms / 1.31 ms | 4.17 ms / 4.83 ms |  |
| `chat.scrollOlderPage` | 0.345 ms / 0.422 ms | 0.400 ms / 0.585 ms | 0.608 ms / 0.866 ms | 2.18 ms / 2.71 ms |  |
| `chat.jumpToMessage` | 0.488 ms / 0.625 ms | 0.527 ms / 0.680 ms | 0.911 ms / 3.48 ms | 2.36 ms / 2.75 ms |  |
| `chat.runtime` | 0.032 ms / 0.038 ms | 0.031 ms / 0.033 ms | 0.033 ms / 0.065 ms | 0.033 ms / 0.043 ms |  |
| `chat.fullSnapshot` | 0.805 ms / 2.45 ms | 3.98 ms / 7.54 ms | 21.6 ms / 26.5 ms | 135 ms / 228 ms |  |
| `chat.recoveryMessages` | 0.332 ms / 0.586 ms | 2.03 ms / 2.29 ms | 10.2 ms / 21.6 ms | 51.7 ms / 175 ms |  |
| `chat.turnAnswer` | 0.074 ms / 0.128 ms | 0.630 ms / 0.821 ms | 3.79 ms / 7.88 ms | 17.8 ms / 37.2 ms |  |
| `boot.runningTurns` | 0.078 ms / 0.086 ms | 1.92 ms / 7.99 ms | 18.8 ms / 46.0 ms | 210 ms / 344 ms | `SCAN projection_turns` |
| `stats.sentMessages` | 0.303 ms / 0.328 ms | 5.20 ms / 5.60 ms | 68.1 ms / 154 ms | 839 ms / 14.10 s | `SCAN projection_thread_messages USING COVERING INDEX thread_messages_shown_order` |
| `search.messagesAll` | 9.56 ms / 16.0 ms | 138 ms / 353 ms | 1.01 s / 3.69 s | 32.75 s / 45.31 s |  |
| `search.messagesAgent` | 9.03 ms / 12.4 ms | 86.6 ms / 188 ms | 983 ms / 4.11 s | 39.71 s / 57.66 s |  |
| `search.files` | 0.239 ms / 0.396 ms | 2.47 ms / 3.92 ms | 23.6 ms / 45.9 ms | 179 ms / 250 ms |  |
| `memory.list` | 0.047 ms / 0.060 ms | 0.194 ms / 0.323 ms | 0.609 ms / 0.857 ms | 0.651 ms / 0.703 ms |  |
| `memory.search` | 0.457 ms / 0.707 ms | 1.35 ms / 2.30 ms | 6.87 ms / 17.5 ms | 8.41 ms / 9.12 ms |  |
| `memory.listPage` | 1.63 ms / 2.06 ms | 4.38 ms / 6.20 ms | 17.0 ms / 40.1 ms | 14.7 ms / 16.4 ms |  |
| `memory.selectionState` | 0.091 ms / 0.135 ms | 0.331 ms / 0.885 ms | 1.33 ms / 3.28 ms | 1.12 ms / 1.33 ms |  |
| `memory.setInclusions` | 0.744 ms / 1.76 ms | 2.54 ms / 6.17 ms | 10.2 ms / 17.3 ms | 8.37 ms / 12.7 ms |  |
| `routines.list` | 0.045 ms / 0.055 ms | 0.068 ms / 0.076 ms | 0.146 ms / 0.321 ms | 0.295 ms / 0.573 ms |  |
| `routines.runs` | 0.150 ms / 0.296 ms | 0.221 ms / 0.235 ms | 0.227 ms / 0.311 ms | 0.233 ms / 0.338 ms |  |
| `routines.pendingRuns` | 0.017 ms / 0.020 ms | 0.017 ms / 0.019 ms | 0.023 ms / 0.039 ms | 0.034 ms / 0.040 ms |  |
| `routines.due` | 0.021 ms / 0.029 ms | 0.020 ms / 0.029 ms | 0.019 ms / 0.031 ms | 0.026 ms / 0.058 ms |  |
| `events.hasAggregate` | 0.010 ms / 0.016 ms | 0.010 ms / 0.019 ms | 0.009 ms / 0.010 ms | 0.011 ms / 0.026 ms |  |
| `tables.list` | 0.775 ms / 1.63 ms | 1.28 ms / 2.93 ms | 6.88 ms / 19.5 ms | 32.4 ms / 34.8 ms |  |
| `tables.query` | 0.371 ms / 0.951 ms | 0.453 ms / 0.605 ms | 3.11 ms / 4.45 ms | 18.6 ms / 21.0 ms |  |
| `write.appendMessage` | 0.288 ms / 0.519 ms | 0.339 ms / 0.475 ms | 0.748 ms / 6.26 ms | 2.85 ms / 3.51 ms |  |
| `write.streamFlush` | 0.166 ms / 0.249 ms | 0.221 ms / 0.308 ms | 0.235 ms / 1.91 ms | 0.259 ms / 0.445 ms |  |
| `write.snapshotPersist` | 1.70 ms / 2.11 ms | 9.31 ms / 10.8 ms | 98.8 ms / 210 ms | 528 ms / 736 ms | `SCAN projection_turns`, `SCAN projection_thread_activities` |
| `write.deleteSideThread` | 2.70 ms / 3.58 ms | 21.5 ms / 46.5 ms | 225 ms / 299 ms | 1.42 s / 26.85 s | `SCAN projection_thread_activities`, `SCAN projection_turns` |
