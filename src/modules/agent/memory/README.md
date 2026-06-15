# agent/memory

Conversation memory wiring (`@mastra/memory` backed by `@mastra/pg`). Holds
context across customer messages and the ad a customer arrived from.

Persisted conversation/message rows remain owned by the `conversations` module;
this directory only configures Mastra's memory layer.
