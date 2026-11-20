# Library search coverage

Rank search results by document after counting its matching chunks. Include filename and display-name matches alongside FTS and local keyword matches. Resolve one body chunk at a time against the same scope and filters so users can verify every match in the original.

1. Add regression inputs for mixed-width text, title-only results, and a document with more than 80 matching chunks. Update search and its request and response types. Keep the question source selection contract.
2. Add previous and next match controls to the existing excerpt view. Keep page and text location navigation available from each result.
3. Verify service and browser regressions, including narrow layout and late responses.
