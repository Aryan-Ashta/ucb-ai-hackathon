# Sponsor Integration Flowcharts

This document maps how each external sponsor/service is used inside the application.

## GitHub — Source ingestion

```mermaid
flowchart TD
    A[User connects GitHub] --> B[GitHub OAuth token]
    B --> C[Backend receives repository/PR/commit data]
    C --> D[Fetch code diff]
    D --> E[Concept extraction pipeline]
    E --> F[Quiz concepts stored for user]
```

## TokenRouter / OpenAI-compatible AI Gateway — LLM processing

```mermaid
flowchart TD
    A[GitHub diff enters backend] --> B[Compress diff with Bear-2]
    B --> C[TokenRouter API endpoint]
    C --> D[Configured model: MiniMax-M3]
    D --> E[Generate JSON concept extraction]
    E --> F[Create QuizConcept objects]
    F --> G[Generate educational roast + quiz]

    H[User answer transcript] --> C
    C --> I[Grade answer]
    I --> J[Return quality score and feedback]
```

## Deepgram — Speech processing

```mermaid
flowchart TD
    A[User speaks quiz answer] --> B[Audio capture in application]
    B --> C[Deepgram speech API]
    C --> D[Speech-to-text transcript]
    D --> E[AI grading pipeline]
    E --> F[Pass/fail + explanation]
```

## Redis Cloud — Caching and state storage

```mermaid
flowchart TD
    A[Extracted QuizConcept] --> B[Redis cache layer]
    B --> C[Store quiz content]
    C --> D[Track spaced repetition state]
    D --> E[Retrieve next due quiz]
    E --> F[User learning loop]
```

## Voyage AI — Vector embeddings / RAG memory

```mermaid
flowchart TD
    A[Extracted concepts] --> B[Build vector index items]
    B --> C[Voyage embedding API]
    C --> D[Semantic vectors]
    D --> E[Vector store]
    E --> F[Retrieve similar previous concepts]
    F --> G[Personalized future prompts]
```

## Sentry — Monitoring and error tracking

```mermaid
flowchart TD
    A[Backend operation] --> B{Error or event?}
    B -->|No| C[Continue application flow]
    B -->|Yes| D[Sentry capture]
    D --> E[Store exception/breadcrumb context]
    E --> F[Developer debugging]
```

## Full application sponsor flow

```mermaid
flowchart LR
    A[GitHub repository] --> B[Backend ingestion]
    B --> C[Bear-2 compression]
    C --> D[TokenRouter LLM]
    D --> E[Quiz generation]
    E --> F[Redis storage]
    E --> G[Voyage embeddings]
    H[User voice answer] --> I[Deepgram transcription]
    I --> D
    D --> J[Feedback]
    B --> K[Sentry observability]
```

Sources inspected in repository:
- `backend/services/claude.py` contains the LLM extraction/grading flow, Redis caching, vector indexing, and Sentry instrumentation.
- `backend/config.py` defines external integrations including TokenRouter, Deepgram, Redis, Sentry, Voyage AI, and GitHub configuration.
