/**
 * V2 architecture Phase 6 (docs/architecture-v2-agent-companion.md §F/§G):
 * the RAG knowledge layer. PostgreSQL-native full-text search
 * (`tsvector` + GIN index) over a dedicated `knowledge_documents` table -
 * explicitly not the `facts`/`fact_versions` chain (that chain is for
 * slowly-changing curated structured facts; these are retrievable
 * unstructured documents), and explicitly not a vector database/embeddings
 * (§G: "Start RAG on Postgres full-text search - not a vector DB").
 *
 * `search_vector` is a generated column so it's always consistent with
 * `title`/`content` - no separate trigger or application-side
 * maintenance needed.
 */

exports.up = (pgm) => {
  pgm.sql(`
    create table knowledge_documents (
      id uuid primary key default gen_random_uuid(),
      -- e.g. 'visa', 'advisory', 'cancellation_policy', 'other' - kept as
      -- free text rather than an enum so a new category never needs a
      -- migration.
      category text not null,
      -- Optional destination scoping - null for a document that isn't
      -- destination-specific (e.g. a provider-wide cancellation policy).
      destination_slug text,
      title text not null,
      content text not null,
      source_name text not null,
      source_url text,
      retrieved_at timestamptz not null default now(),
      search_vector tsvector generated always as
        (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(content, ''))) stored,
      created_at timestamptz not null default now()
    );

    create index idx_knowledge_documents_search on knowledge_documents using gin(search_vector);
    create index idx_knowledge_documents_destination on knowledge_documents(destination_slug);
    create index idx_knowledge_documents_category on knowledge_documents(category);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    drop table if exists knowledge_documents cascade;
  `);
};
