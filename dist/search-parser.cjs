"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/search-parser.ts
var search_parser_exports = {};
__export(search_parser_exports, {
  buildFTSQuery: () => buildFTSQuery,
  parseSearchQuery: () => parseSearchQuery
});
module.exports = __toCommonJS(search_parser_exports);
function parseSearchQuery(query) {
  const parsed = {
    raw: query,
    terms: [],
    filters: {}
  };
  const tokens = query.split(/\s+/);
  for (const token of tokens) {
    if (!token)
      continue;
    if (token.startsWith("type:")) {
      parsed.type = token.substring(5);
    } else if (token.startsWith("author:")) {
      parsed.filters.author = token.substring(7);
    } else if (token.startsWith("kind:")) {
      const kind = parseInt(token.substring(5));
      if (!isNaN(kind)) {
        parsed.filters.kinds = [kind];
      }
    } else if (token.startsWith("#")) {
      if (!parsed.filters.hashtags)
        parsed.filters.hashtags = [];
      parsed.filters.hashtags.push(token.substring(1));
    } else if (token.startsWith("min_likes:")) {
      const val = parseInt(token.substring(10));
      if (!isNaN(val)) {
        parsed.filters.min_likes = val;
      }
    } else if (token.startsWith("min_loops:")) {
      const val = parseInt(token.substring(10));
      if (!isNaN(val)) {
        parsed.filters.min_loops = val;
      }
    } else if (token.startsWith("since:")) {
      const val = parseInt(token.substring(6));
      if (!isNaN(val)) {
        parsed.filters.since = val;
      }
    } else if (token.startsWith("until:")) {
      const val = parseInt(token.substring(6));
      if (!isNaN(val)) {
        parsed.filters.until = val;
      }
    } else {
      parsed.terms.push(token);
    }
  }
  return parsed;
}
function buildFTSQuery(terms) {
  if (terms.length === 0)
    return "";
  return terms.map((t) => `${t}*`).join(" OR ");
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  buildFTSQuery,
  parseSearchQuery
});
