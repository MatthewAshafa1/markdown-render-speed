# markdown-render-speed

[![make.fun](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/c/markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/MatthewAshafa1/markdown-render-speed/rank.svg)](https://make.fun/c/markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/MatthewAshafa1/markdown-render-speed/reward.svg)](https://make.fun/c/markdown-render-speed-02)

A fast, dependency-free Markdown renderer whose `parse()` returns exactly
the HTML that marked 18.1.3 renders with its default options (GFM on,
breaks off, pedantic off, async off) — a drop-in replacement for marked,
written from the CommonMark 0.31.2 and GFM 0.29 specifications.

## Layout

- `parse.js` — the renderer. `parse(markdown)` returns the HTML string.
  No dependencies, no caching between calls.
- `main.ts` — the program the harness runs: reads every case from
  `/input/cases.json`, renders each with `parse`, writes `/output/html.json`.

## How it works

`parse()` normalises line endings, splits the input into lines, and runs a
line-based block parser (block quotes, lists and list items as containers;
paragraphs, headings, code, HTML blocks and tables as leaves) that collects
link reference definitions, then renders each block, parsing inline markup
(code spans, emphasis, links, autolinks, entities, escapes) with a
delimiter-stack emphasis resolver. Output is built with plain string
operations, avoiding the repeated regular-expression passes of a
regex-driven lexer, which is where the speed comes from.
