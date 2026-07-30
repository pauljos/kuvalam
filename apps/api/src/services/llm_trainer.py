#!/usr/bin/env python3
import argparse
import sys
import time
import os
import re

# ─── Ollama tag → HuggingFace model ID mapping ──────────────────────────────
# The DB stores Ollama-style tags (e.g. "qwen2.5:0.5b") but transformers'
# from_pretrained() needs a HuggingFace model ID. This dict maps common ones.
OLLAMA_TO_HF = {
    "qwen2.5:0.5b":         "Qwen/Qwen2.5-0.5B-Instruct",
    "qwen2.5:1.5b":         "Qwen/Qwen2.5-1.5B-Instruct",
    "qwen2.5:3b":           "Qwen/Qwen2.5-3B-Instruct",
    "qwen2.5:7b":           "Qwen/Qwen2.5-7B-Instruct",
    "qwen2.5-coder:0.5b":   "Qwen/Qwen2.5-Coder-0.5B-Instruct",
    "qwen2.5-coder:1.5b":   "Qwen/Qwen2.5-Coder-1.5B-Instruct",
    "tinyllama:latest":     "TinyLlama/TinyLlama-1.1B-Chat-v1.0",
    "tinyllama:1.1b":       "TinyLlama/TinyLlama-1.1B-Chat-v1.0",
    "phi:latest":           "microsoft/phi-2",
    "phi-2:latest":         "microsoft/phi-2",
    "phi-2":                "microsoft/phi-2",
    "gemma2:2b":            "google/gemma-2-2b-it",
    "gemma:2b":             "google/gemma-2-2b-it",
    "stablelm2:1.6b":       "stabilityai/stablelm-2-1_6b",
    "llama3.2:latest":      "meta-llama/Llama-3.2-3B-Instruct",
    "llama3.2:1b":          "meta-llama/Llama-3.2-1B-Instruct",
    "llama3.2:3b":          "meta-llama/Llama-3.2-3B-Instruct",
    "smollm2:360m":         "HuggingFaceTB/SmolLM2-360M-Instruct",
    "smollm:360m":          "HuggingFaceTB/SmolLM2-360M-Instruct",
}

def _resolve_model_id(tag):
    """Convert an Ollama-style tag to a HuggingFace model ID if possible."""
    if not tag:
        return tag
    # If it looks like a HuggingFace ID already (contains '/'), use as-is
    if '/' in tag and not tag.startswith('hf.co/'):
        return tag
    # Strip 'hf.co/' prefix that Ollama sometimes uses
    clean = tag.replace('hf.co/', '')
    # Check explicit mapping
    if clean in OLLAMA_TO_HF:
        return OLLAMA_TO_HF[clean]
    # Try dropping the version tag after ':' (e.g. "qwen2.5:0.5b" → try "qwen2.5")
    if ':' in clean:
        base = clean.split(':')[0]
        if base in OLLAMA_TO_HF:
            return OLLAMA_TO_HF[base]
    # Last resort: convert common patterns programmatically
    # e.g. "qwen2.5:0.5b" → "Qwen/Qwen2.5-0.5B-Instruct"
    m = re.match(r'^([a-z0-9]+(?:[.-][a-z0-9]+)*):?([\d.]+[bBmM])?$', clean)
    if m:
        name = m.group(1)
        size = m.group(2) or ''
        # CamelCase the name
        parts = re.split(r'[.-]', name)
        camel = ''.join(p.capitalize() for p in parts)
        if size:
            size_upper = size.upper()
            return f'{camel}/{camel}-{size_upper}-Instruct'
    # Give up — let from_pretrained() figure it out
    return clean


# ─── Ontology Training Data Generator ─────────────────────────────────────────
# Converts database tables into an ontology (knowledge graph) of triples.
# Instead of raw row dumps, the model learns:
#   - Classes (what tables exist and what they represent)
#   - Properties (what columns each class has)
#   - Relationships (how classes connect via foreign keys)
#   - Instances (actual data as entity→property→value triples)
#   - Relation links (instance→relationship→instance triples)
#
# This teaches the model the *structure* and *semantics* of the data,
# not just memorized values. The model can reason transitively:
#   Customer → placedOrder → Order → contains → Product → belongsTo → Category

def _detect_foreign_keys(table_map):
    """
    Detect likely foreign key relationships by name patterns.
    table_map: {table_key: {columns, rows, schema}}
    Returns: list of (from_table, to_table, fk_column)
    """
    relationships = []

    # Build singular forms
    table_name_singular = {}
    for key in table_map:
        tbl = key.split(".")[-1]
        s = tbl
        if s.endswith("ies"):
            s = s[:-3] + "y"
        elif s.endswith("tuses") or s.endswith("sses"):
            s = s[:-2]
        elif s.endswith("es"):
            s = s[:-2]
        elif s.endswith("s") and not s.endswith("ss"):
            s = s[:-1]
        table_name_singular[key] = s

    # ── Known FK mapping for common patterns (column → target table) ────
    # Handles columns that don't follow the _id naming convention,
    # e.g., orders.ship_via → shippers, employees.reports_to → employees
    KNOWN_FK_MAP = {
        "ship_via": "shippers",
        "reports_to": "employees",
        "ship_country": None,  # Not a FK, just a value — skip
    }

    for key, info in table_map.items():
        tbl = key.split(".")[-1]
        for c in info["columns"]:
            c_lower = c.lower()

            # Pattern 1: Standard _id columns (e.g., customer_id → customers)
            if c_lower.endswith("_id"):
                for other_key, other_info in table_map.items():
                    if other_key == key:
                        continue
                    other_tbl = other_key.split(".")[-1]
                    other_singular = table_name_singular[other_key]
                    # Match: column name contains target table name (full or singular)
                    col_base = c_lower[:-3]  # strip "_id"
                    if (other_tbl in c_lower or other_singular in col_base or
                        col_base == other_tbl or col_base == other_singular):
                        relationships.append((tbl, other_tbl, c))
                        break

            # Pattern 2: Known FK mappings (non-_id columns)
            elif c_lower in KNOWN_FK_MAP:
                target = KNOWN_FK_MAP[c_lower]
                if target and any(k.split(".")[-1] == target for k in table_map):
                    relationships.append((tbl, target, c))

            # Pattern 3: Column contains a table name somewhere in it
            # e.g., city → not a FK; ship_via → "ship" matches nothing but "shippers" via KNOWN_FK_MAP
            else:
                for other_key in table_map:
                    if other_key == key:
                        continue
                    other_tbl = other_key.split(".")[-1]
                    other_singular = table_name_singular[other_key]
                    # Check if column name or any part of it matches a table name
                    parts = c_lower.replace("_", " ").split()
                    for part in parts:
                        if part == other_singular or part == other_tbl:
                            relationships.append((tbl, other_tbl, c))
                            break
                    else:
                        continue
                    break

    # Deduplicate
    seen = set()
    unique_rels = []
    for rel in relationships:
        if rel not in seen:
            seen.add(rel)
            unique_rels.append(rel)

    return unique_rels


def _generate_ontology_training_data(all_tables_data, db_name="database"):
    """
    Convert database tables into ontology triples for training.
    
    all_tables_data: list of (schema, table_name, column_names, rows_dict_list)
    Returns: list of {"text": "..."} training samples
    """
    samples = []
    table_map = {}
    
    for schema, table, col_names, rows in all_tables_data:
        key = f"{schema}.{table}"
        for i, r in enumerate(rows[:5]):
            if not isinstance(r, dict):
                raise TypeError(f"Row {i} in table {key} is {type(r).__name__}, expected dict. Value: {r}")
        table_map[key] = {"columns": col_names, "rows": rows, "schema": schema}

    if not table_map:
        return samples

    relationships = _detect_foreign_keys(table_map)

    # ── 1. ONTOLOGY HEADER ──────────────────────────────────────────────
    header = f"╔═══ {db_name.upper()} ONTOLOGY ═══╗\n"
    header += f"This database contains {len(table_map)} classes:\n"
    class_list = ", ".join(k.split(".")[-1] for k in table_map)
    header += class_list
    samples.append({"text": header})

    # ── 2. CLASS DEFINITIONS (schema / TBox) ────────────────────────────
    for key, info in table_map.items():
        tbl = key.split(".")[-1]
        cols = info["columns"]
        rows = info["rows"]
        count = len(rows)

        # Class overview
        lines = [f"\n── Class: {tbl} ──"]
        lines.append(f"Class: {tbl}")
        lines.append(f"  Description: Represents {tbl.lower()} in the {db_name} database")
        lines.append(f"  Instance count: {count}")

        # Properties (columns)
        lines.append(f"  Properties ({len(cols)}):")
        for c in cols:
            # Infer domain/range from sample values
            sample_vals = []
            ctype = "text"
            for r in rows[:20]:
                v = r.get(c, "")
                if v and str(v).strip():
                    sample_vals.append(str(v).strip())
                    try:
                        float(v)
                        ctype = "numeric"
                    except (ValueError, TypeError):
                        pass
            display_vals = ", ".join(f'"{v}"' for v in sample_vals[:3])
            if len(sample_vals) > 3:
                display_vals += f" ... ({len(sample_vals)} distinct)"
            lines.append(f"    - {c} ({ctype})")
            if display_vals:
                lines.append(f"      Sample values: {display_vals}")
            # Suggest natural language label
            if c == "company_name":
                lines.append(f"      Label: {tbl} name")
            elif c == "contact_name":
                lines.append(f"      Label: contact person")
            elif c == "product_name":
                lines.append(f"      Label: product name")
            elif c.endswith("_id"):
                lines.append(f"      Label: {tbl} identifier")

        # Relationships (foreign keys to other classes)
        tbl_short = key.split(".")[-1]
        fk_rels = [(f, t, c) for f, t, c in relationships if f == tbl_short]
        if fk_rels:
            lines.append(f"  Relationships:")
            for f, t, c in fk_rels:
                # Generate a natural predicate name
                pred = c.replace("_id", "").replace("_", " ")
                lines.append(f"    - {tbl_short} → {t} via {c}")
                lines.append(f"      Predicate: {tbl_short} has{pred.capitalize()} {t}")
                lines.append(f"      Each {tbl_short} can be linked to one {t}")

        # Reverse relationships (other tables pointing to this one)
        rev_rels = [(f, t, c) for f, t, c in relationships if t == tbl_short]
        if rev_rels:
            for f, t, c in rev_rels:
                lines.append(f"    - {f} → {tbl_short} (reverse: {f} has {tbl_short})")
                lines.append(f"      One {tbl_short} can be referenced by many {f}")

        samples.append({"text": "\n".join(lines)})

    # ── 3. INSTANCE TRIPLES (ABox — individual data) ────────────────────
    # For each table, convert rows into ontology triples
    for key, info in table_map.items():
        tbl = key.split(".")[-1]
        cols = info["columns"]
        rows = info["rows"]

        if not rows:
            continue

        # Build batch of triples for this table's instances (up to 50 rows)
        batch_size = 0
        triple_lines = [f"\n── {tbl} Instances ──"]

        for r in rows[:50]:
            # Determine the primary identifier for this instance
            inst_id = None
            for c in cols:
                if c in ("id", f"{tbl.lower()}_id", "customer_id", "product_id", "order_id",
                         "employee_id", "supplier_id", "category_id", "shipper_id",
                         "territory_id", "region_id"):
                    inst_id = r.get(c, "")
                    break
            if not inst_id:
                # Use first column as identifier
                inst_id = r.get(cols[0], f"{tbl}_{batch_size}")

            inst_uri = f"{tbl}:{inst_id}"
            triple_lines.append(f"\nInstance: {inst_uri}")
            triple_lines.append(f"  rdf:type {tbl}")

            # Property triples
            for c in cols:
                val = r.get(c, "")
                if val is not None and str(val).strip():
                    # Escape quotes in values
                    safe_val = str(val).replace('"', "'")
                    triple_lines.append(f"  {tbl}:{c} \"{safe_val}\"")
                    batch_size += 1

        if batch_size > 0:
            samples.append({"text": "\n".join(triple_lines)})

    # ── 4. RELATIONSHIP TRIPLES (links between instances) ────────────────
    # Generate explicit cross-table relationship triples based on FK values
    rel_lines = ["\n── Relationship Triples ──"]
    rel_count = 0

    for from_tbl, to_tbl, fk_col in relationships:
        from_key = None
        to_key = None
        for k in table_map:
            if k.split(".")[-1] == from_tbl:
                from_key = k
            if k.split(".")[-1] == to_tbl:
                to_key = k

        if not from_key or not to_key:
            continue

        from_info = table_map[from_key]
        to_info = table_map[to_key]

        # Build lookup: FK value → to_tbl instance
        to_lookup = {}
        to_id_col = None
        for c in to_info["columns"]:
            if c in ("id", f"{to_tbl.lower()}_id", "customer_id", "product_id", "order_id",
                     "employee_id", "supplier_id", "category_id", "shipper_id",
                     "territory_id", "region_id"):
                to_id_col = c
                break
        if not to_id_col:
            to_id_col = to_info["columns"][0]

        for r in to_info["rows"]:
            rid = r.get(to_id_col, "")
            if rid:
                to_lookup[str(rid)] = f"{to_tbl}:{rid}"

        # Generate predicate name
        pred = f"has{to_tbl.capitalize()}"

        # Link from instances to to instances via FK
        for r in from_info["rows"]:
            fk_val = str(r.get(fk_col, ""))
            if fk_val and fk_val in to_lookup:
                # Find from instance ID
                from_id_col = None
                for c in from_info["columns"]:
                    if c in ("id", f"{from_tbl.lower()}_id", "customer_id", "product_id", "order_id",
                             "employee_id", "supplier_id", "category_id", "shipper_id",
                             "territory_id", "region_id"):
                        from_id_col = c
                        break
                if not from_id_col:
                    from_id_col = from_info["columns"][0]

                from_id = r.get(from_id_col, "")
                if from_id:
                    from_uri = f"{from_tbl}:{from_id}"
                    to_uri = to_lookup[fk_val]
                    rel_lines.append(f"  {from_uri} {pred} {to_uri}")
                    rel_count += 1

                    # Also generate the reverse triple
                    rev_pred = f"referencedBy{from_tbl.capitalize()}"
                    rel_lines.append(f"  {to_uri} {rev_pred} {from_uri}")

                    if rel_count >= 200:
                        break
            if rel_count >= 200:
                break
        if rel_count >= 200:
            break

    if rel_count > 0:
        rel_lines.append(f"\nTotal relationship triples: {rel_count}")
        samples.append({"text": "\n".join(rel_lines)})

    # ── 5. ONTOLOGY SUMMARY ─────────────────────────────────────────────
    total_instances = sum(len(info["rows"]) for info in table_map.values())
    total_properties = sum(len(info["columns"]) for info in table_map.values())
    summary = [
        f"\n── Ontology Summary ──",
        f"Database: {db_name}",
        f"Classes: {len(table_map)}",
        f"Total instances: {total_instances}",
        f"Total properties: {total_properties}",
        f"Relationships: {len(relationships)}",
        f"Classes: {', '.join(k.split('.')[-1] for k in table_map)}",
    ]
    if relationships:
        summary.append("Relationships:")
        for f, t, c in relationships:
            summary.append(f"  {f}.{c} → {t}")
    samples.append({"text": "\n".join(summary)})

    print(f"   Generated {len(samples)} ontology training blocks ({total_instances} instances across {len(table_map)} classes)")
    sys.stdout.flush()
    return samples


# ─── Database Q&A Pair Generator ─────────────────────────────────────────────
# Generates question-answer training pairs from extracted table data.
# Combined with raw row dumps to teach the model both facts and Q&A format.

def _generate_db_qa_pairs(all_tables_data, db_name="database"):
    """
    all_tables_data: list of (schema, table_name, column_names, rows_dict_list)
    Returns: list of {"text": "Q: ... A: ..."} training pairs
    """
    pairs = []
    table_map = {}  # table_name -> {columns, rows}

    for schema, table, col_names, rows in all_tables_data:
        key = f"{schema}.{table}"
        # Validate row types
        for i, r in enumerate(rows[:5]):
            if not isinstance(r, dict):
                raise TypeError(f"Row {i} in table {key} is {type(r).__name__}, expected dict. Value: {r}")
        table_map[key] = {"columns": col_names, "rows": rows}

    # ── Generic questions for every table ───────────────────────────────
    for key, info in table_map.items():
        cols = info["columns"]
        rows = info["rows"]
        tbl_short = key.split(".")[-1]
        count = len(rows)

        # List all rows
        if count > 0 and count <= 60:
            lines = []
            for r in rows:
                vals = ", ".join(f"{c}={r.get(c, '')}" for c in cols[:6])
                if len(cols) > 6:
                    vals += ", ..."
                lines.append(vals)
            answer = "\n".join(lines)
            pairs.append({"text": f"Q: List all {tbl_short}\nA: {answer}"})
            pairs.append({"text": f"Q: What are the {tbl_short}?\nA: {answer}"})

        # Count
        pairs.append({"text": f"Q: How many {tbl_short} are there?\nA: There are {count} {tbl_short}."})
        pairs.append({"text": f"Q: Count of {tbl_short}\nA: {count}"})

        # Show first few
        if count > 0:
            sample_vals = ", ".join(f"{c}={rows[0].get(c, '')}" for c in cols[:4])
            pairs.append({"text": f"Q: Show me a sample {tbl_short}\nA: Here is one {tbl_short}: {sample_vals}"})

    # ── Specific column-value lookups ──────────────────────────────────
    for key, info in table_map.items():
        cols = info["columns"]
        rows = info["rows"]
        tbl_short = key.split(".")[-1]

        for c in cols[:3]:  # first few columns as identifiers
            for r in rows[:20]:
                val = r.get(c, "")
                if val and str(val).strip():
                    details = ", ".join(f"{cc}={r.get(cc, '')}" for cc in cols[:6])
                    pairs.append({"text": f"Q: Find {tbl_short} where {c}={val}\nA: {details}"})
                    pairs.append({"text": f"Q: What is {c}={val} in {tbl_short}?\nA: {details}"})
                    break  # one example per column

    # ── Multi-table join questions (GENERIC — works for any database) ────
    # Detects relationships via FK patterns, then generates:
    #   1. "What X did Y have?" for each parent→child pair
    #   2. Top-N by count for each relationship
    #   3. Top-N by numeric metric for join chains (A→B→C)
    #   4. FK lookup enrichment (e.g., "what category is this in?")

    relationships = _detect_foreign_keys(table_map)

    # ── Helper: find a display/name column for a table ─────────────────
    def _find_display_col(info, prefer_human=True):
        """Find the best human-readable column to identify a row."""
        cols = info["columns"]
        # Prefer columns that look like names/labels
        human_patterns = ['name', 'title', 'label', 'description', 'company', 'first_name', 'last_name']
        for pat in human_patterns:
            for c in cols:
                if pat in c.lower():
                    return c
        # Otherwise, first non-id text column
        for c in cols:
            if not c.endswith("_id") and c.lower() != "id":
                # Check if it looks textual from sample data
                for r in info["rows"][:3]:
                    v = r.get(c, "")
                    if v and str(v).strip() and not str(v).strip().replace('.', '').replace('-', '').isdigit():
                        return c
        # Fallback: first column
        return cols[0] if cols else None

    def _get_full_key(short_tbl):
        for k in table_map:
            if k.split(".")[-1] == short_tbl:
                return k
        return None

    # ── 1. GENERIC RELATIONSHIP QUESTIONS ───────────────────────────────
    # For each parent→child FK: "what children does this parent have?"
    for from_tbl, to_tbl, fk_col in relationships:
        from_key = _get_full_key(from_tbl)
        to_key = _get_full_key(to_tbl)
        if not from_key or not to_key:
            continue

        from_info = table_map[from_key]
        to_info = table_map[to_key]
        from_rows = from_info["rows"]
        to_rows = to_info["rows"]

        from_display = _find_display_col(from_info)
        to_display = _find_display_col(to_info)

        if not from_display or not to_display:
            continue

        # Build FK lookup: from_id_value → list of child rows
        child_map = {}
        for r in to_rows:
            fk_val = str(r.get(fk_col, ""))
            if fk_val:
                child_map.setdefault(fk_val, []).append(r)

        # Find the ID column of the parent
        from_id_col = None
        for c in from_info["columns"]:
            if c in ("id", "customer_id", "product_id", "order_id", "employee_id",
                     "supplier_id", "category_id", "shipper_id", "territory_id", "region_id"):
                from_id_col = c
                break
        if not from_id_col:
            from_id_col = from_info["columns"][0]

        # ── Per-parent: what children? ────────────────────────────────
        for pr in from_rows[:15]:
            pid_val = str(pr.get(from_id_col, ""))
            pname = pr.get(from_display, pid_val)
            children = child_map.get(pid_val, [])
            if children and to_display:
                child_list = "; ".join(
                    str(c.get(to_display, ""))
                    for c in children[:8]
                )
                if len(children) > 8:
                    child_list += f", ... ({len(children)} total)"
                pairs.append({"text": f"Q: What {to_tbl} does {pname} have?\nA: {pname} has {len(children)} {to_tbl}: {child_list}"})
                pairs.append({"text": f"Q: {pname}'s {to_tbl}\nA: {child_list}"})

        # ── How many children per parent? ─────────────────────────────
        parent_child_counts = []
        for pr in from_rows:
            pid_val = str(pr.get(from_id_col, ""))
            pname = pr.get(from_display, pid_val)
            cnt = len(child_map.get(pid_val, []))
            parent_child_counts.append((pid_val, pname, cnt))

        parent_child_counts.sort(key=lambda x: -x[2])
        total_children = sum(c[2] for c in parent_child_counts)
        pairs.append({"text": f"Q: How many {to_tbl} per {from_tbl}?\nA: " +
            "; ".join(f"{pname}: {cnt}" for _, pname, cnt in parent_child_counts[:20]) +
            (f" ... ({len(parent_child_counts)} total {from_tbl})" if len(parent_child_counts) > 20 else "")})

        # ── TOP 5 BY COUNT ───────────────────────────────────────────
        top5 = parent_child_counts[:5]
        if top5 and top5[0][2] > 0:
            top5_text = "; ".join(
                f"#{i+1} {pname} — {cnt} {to_tbl}"
                for i, (_, pname, cnt) in enumerate(top5)
            )
            pairs.append({"text": f"Q: Top 5 {from_tbl} by number of {to_tbl}\nA: {top5_text}"})
            pairs.append({"text": f"Q: Which {from_tbl} have the most {to_tbl}?\nA: {top5_text}"})

            # Top 3
            top3 = parent_child_counts[:3]
            top3_text = "; ".join(
                f"#{i+1} {pname} — {cnt} {to_tbl}"
                for i, (_, pname, cnt) in enumerate(top3)
            )
            pairs.append({"text": f"Q: Top 3 {from_tbl} by {to_tbl} count\nA: {top3_text}"})

            # Individual rank
            for i, (_, pname, cnt) in enumerate(top5[:3]):
                pairs.append({"text": f"Q: How many {to_tbl} does {pname} have?\nA: {pname} has {cnt} {to_tbl}, ranking #{i+1} among all {from_tbl}."})

        # ── FK LOOKUP ENRICHMENT ──────────────────────────────────────
        # "What X is this Y in?" — enrich parent rows with FK target data
        for pr in from_rows[:20]:
            fk_val = str(pr.get(fk_col, ""))
            pid_val = str(pr.get(from_id_col, ""))
            pname = pr.get(from_display, pid_val)
            # Find the FK target row
            target_row = None
            for tr in to_rows:
                target_id_col = None
                for c in to_info["columns"]:
                    if c in ("id", "customer_id", "product_id", "order_id", "employee_id",
                             "supplier_id", "category_id", "shipper_id", "territory_id", "region_id"):
                        target_id_col = c
                        break
                if not target_id_col:
                    target_id_col = to_info["columns"][0]
                if str(tr.get(target_id_col, "")) == fk_val:
                    target_row = tr
                    break

            if target_row and to_display:
                tname = target_row.get(to_display, fk_val)
                pairs.append({"text": f"Q: What {to_tbl} is {pname} in?\nA: {pname} ({from_tbl}) is in {tname} ({to_tbl})."})
                pairs.append({"text": f"Q: {pname}'s {to_tbl}\nA: {pname} belongs to {tname}."})
                break  # one example per parent table

        # ── Group by FK (e.g., "how many products per category?") ─────
        fk_counts = {}
        for pr in from_rows:
            fk_val = str(pr.get(fk_col, ""))
            fk_counts[fk_val] = fk_counts.get(fk_val, 0) + 1

        if len(fk_counts) > 1:
            # Build FK value → name lookup
            fk_name_map = {}
            target_id_col = None
            for c in to_info["columns"]:
                if c in ("id", "customer_id", "product_id", "order_id", "employee_id",
                         "supplier_id", "category_id", "shipper_id", "territory_id", "region_id"):
                    target_id_col = c
                    break
            if not target_id_col:
                target_id_col = to_info["columns"][0]
            for tr in to_rows:
                tid = str(tr.get(target_id_col, ""))
                tname = tr.get(to_display, tid)
                fk_name_map[tid] = tname

            grouped = []
            for fk_val, cnt in sorted(fk_counts.items(), key=lambda x: -x[1]):
                name = fk_name_map.get(fk_val, fk_val)
                grouped.append(f"{name}: {cnt}")
            pairs.append({"text": f"Q: How many {from_tbl} per {to_tbl}?\nA: " + "; ".join(grouped[:15])})

            # Most common
            top_group = max(fk_counts, key=fk_counts.get)
            top_group_name = fk_name_map.get(top_group, top_group)
            pairs.append({"text": f"Q: Which {to_tbl} has the most {from_tbl}?\nA: {top_group_name} has the most {from_tbl} ({fk_counts[top_group]})."})

    # ── 2. JOIN CHAIN TOP-N BY METRIC ────────────────────────────────────
    # Detect A→B→C chains and compute top-N A by aggregated C metric
    join_chains = []
    for a_tbl, b_tbl, fk_ab in relationships:
        for c_tbl, d_tbl, fk_cd in relationships:
            if b_tbl == c_tbl and a_tbl != d_tbl:
                join_chains.append((a_tbl, b_tbl, fk_ab, d_tbl, fk_cd))

    for a_tbl, b_tbl, fk_ab, c_tbl, fk_bc in join_chains[:10]:
        a_key = _get_full_key(a_tbl)
        b_key = _get_full_key(b_tbl)
        c_key = _get_full_key(c_tbl)
        if not (a_key and b_key and c_key):
            continue

        a_info = table_map[a_key]
        b_info = table_map[b_key]
        c_info = table_map[c_key]

        a_display = _find_display_col(a_info)
        if not a_display:
            continue

        # Find ID columns
        a_id = None
        for c in a_info["columns"]:
            if c.lower() == "id" or c.endswith("_id"):
                a_id = c
                break
        if not a_id:
            a_id = a_info["columns"][0]

        # Build B-ID → A-ID mapping via fk_ab
        b_to_a = {}
        for r in b_info["rows"]:
            bid = str(r.get("id", r.get(b_info["columns"][0], "")))
            aid = str(r.get(fk_ab, ""))
            if bid and aid:
                b_to_a[bid] = aid

        # Find numeric columns in C for aggregation
        c_numeric = []
        for col in c_info["columns"]:
            for r in c_info["rows"][:5]:
                try:
                    v = r.get(col, "")
                    if v and v != "":
                        float(v)
                        c_numeric.append(col)
                        break
                except (ValueError, TypeError):
                    pass

        # Find FK in C pointing to B
        c_fk_to_b = None
        for col in c_info["columns"]:
            if col.endswith("_id"):
                col_base = col[:-3].lower()
                if col_base == b_tbl.lower() or col_base in b_tbl.lower():
                    c_fk_to_b = col
                    break
        if not c_fk_to_b:
            # Try matching by name patterns
            for col in c_info["columns"]:
                if b_tbl.lower() in col.lower() and col != "id":
                    c_fk_to_b = col
                    break

        if c_fk_to_b and c_numeric:
            # Compute per-A aggregated values
            a_metrics = {}  # a_id → {count, sum_col1, sum_col2, ...}
            for r in c_info["rows"]:
                bid = str(r.get(c_fk_to_b, ""))
                aid = b_to_a.get(bid, "")
                if not aid:
                    continue
                if aid not in a_metrics:
                    a_metrics[aid] = {"count": 0}
                    for cn in c_numeric:
                        a_metrics[aid][f"sum_{cn}"] = 0
                a_metrics[aid]["count"] += 1
                for cn in c_numeric:
                    try:
                        a_metrics[aid][f"sum_{cn}"] += float(r.get(cn, 0) or 0)
                    except (ValueError, TypeError):
                        pass

            if a_metrics:
                # Build A-ID → name lookup
                a_names = {}
                for r in a_info["rows"]:
                    aid_val = str(r.get(a_id, ""))
                    aname = r.get(a_display, aid_val)
                    a_names[aid_val] = aname

                # Top 5 by count
                ranked_count = sorted(a_metrics.items(), key=lambda x: -x[1]["count"])
                top5 = ranked_count[:5]
                if top5 and top5[0][1]["count"] > 0:
                    top5_text = "; ".join(
                        f"#{i+1} {a_names.get(aid, aid)} — {m['count']} records"
                        for i, (aid, m) in enumerate(top5)
                    )
                    pairs.append({"text": f"Q: Top 5 {a_tbl} by {c_tbl} count\nA: {top5_text}"})
                    pairs.append({"text": f"Q: Which {a_tbl} have the most {c_tbl} records?\nA: {top5_text}"})

                # Top 5 by each numeric sum
                for cn in c_numeric[:2]:
                    sum_key = f"sum_{cn}"
                    ranked_sum = sorted(
                        [(aid, m) for aid, m in a_metrics.items() if m.get(sum_key, 0) > 0],
                        key=lambda x: -x[1].get(sum_key, 0)
                    )
                    top5_sum = ranked_sum[:5]
                    if top5_sum:
                        top5_sum_text = "; ".join(
                            f"#{i+1} {a_names.get(aid, aid)} — {m[sum_key]:,.2f} total {cn}"
                            for i, (aid, m) in enumerate(top5_sum)
                        )
                        pairs.append({"text": f"Q: Top 5 {a_tbl} by total {cn} in {c_tbl}\nA: {top5_sum_text}"})
                        pairs.append({"text": f"Q: Which {a_tbl} have the highest total {cn}?\nA: {top5_sum_text}"})

    # ── 3. GENERIC PER-TABLE GROUPING QUESTIONS ──────────────────────────
    # For columns that look categorical (few unique values), generate
    # "how many X per Y?" and "most common Y?"
    for key, info in table_map.items():
        tbl = key.split(".")[-1]
        cols = info["columns"]
        rows = info["rows"]
        if len(rows) < 2:
            continue

        for c in cols[:5]:
            vals = [str(r.get(c, "")).strip() for r in rows if r.get(c, "") and str(r.get(c, "")).strip()]
            unique = list(set(vals))
            if 2 <= len(unique) <= 15 and len(unique) < len(vals) * 0.8:
                # This column looks categorical — generate grouping questions
                counts = {}
                for v in vals:
                    counts[v] = counts.get(v, 0) + 1

                # Count per value
                grouped = sorted(counts.items(), key=lambda x: -x[1])
                pairs.append({"text": f"Q: How many {tbl} per {c}?\nA: " +
                    "; ".join(f"{v}: {n}" for v, n in grouped)})

                # Most common
                most_common = max(counts, key=counts.get)
                pairs.append({"text": f"Q: What is the most common {c} in {tbl}?\nA: The most common {c} is '{most_common}' with {counts[most_common]} {tbl}."})
                break  # one categorical column per table is enough

    # ── 4. PER-TABLE SUMMARY ─────────────────────────────────────────────
    for key, info in table_map.items():
        tbl = key.split(".")[-1]
        cols = info["columns"]
        rows = info["rows"]
        count = len(rows)

        # Numeric column aggregates
        for c in cols[:5]:
            num_vals = []
            for r in rows:
                try:
                    v = float(r.get(c, ""))
                    num_vals.append(v)
                except (ValueError, TypeError):
                    pass
            if len(num_vals) > len(rows) * 0.5 and num_vals:
                total = sum(num_vals)
                avg = total / len(num_vals)
                pairs.append({"text": f"Q: What is the total {c} in {tbl}?\nA: The total {c} is {total:,.2f}."})
                pairs.append({"text": f"Q: What is the average {c} in {tbl}?\nA: The average {c} is {avg:,.2f}."})
                break  # one aggregate per table

    print(f"   Generated {len(pairs)} Q&A training pairs")
    sys.stdout.flush()
    return pairs


# ─── Text-to-SQL Training Pair Generator ─────────────────────────────────────
# Automatically generates (natural language → SQL query) pairs from any schema.
# This is the generic approach — works for ANY database without manual SQL writing.
# Combined with row dumps, the model learns both facts AND how to query.

def _generate_text_to_sql_pairs(all_tables_data):
    """
    all_tables_data: list of (schema, table, column_names, rows_dict_list)
    Returns: list of {"text": "Q: ... A: ..."} with SQL queries
    """
    pairs = []
    table_map = {}
    for schema, table, col_names, rows in all_tables_data:
        table_map[f"{schema}.{table}"] = {"columns": col_names, "rows": rows, "schema": schema}

    # Build column type heuristics from data
    col_types = {}  # table.col -> type guess
    for key, info in table_map.items():
        tbl_short = key.split(".")[-1]
        for c in info["columns"]:
            col_key = f"{tbl_short}.{c}"
            if info["rows"]:
                vals = [r.get(c, "") for r in info["rows"][:20] if r.get(c, "") != ""]
                if vals:
                    # Try to detect number columns
                    numeric_vals = []
                    for v in vals:
                        try:
                            float(v)
                            numeric_vals.append(v)
                        except (ValueError, TypeError):
                            pass
                    if len(numeric_vals) > len(vals) * 0.5:
                        col_types[col_key] = "numeric"
                    else:
                        col_types[col_key] = "text"
                else:
                    col_types[col_key] = "text"
            else:
                col_types[col_key] = "text"

    # ── Detect potential foreign keys using shared function ─────────────
    relationships = _detect_foreign_keys(table_map)

    # ── 1. Simple SELECT with WHERE for each table ──────────────────────
    for key, info in table_map.items():
        tbl = key.split(".")[-1]
        cols = info["columns"]
        rows = info["rows"]

        if not cols:
            continue

        # SELECT all
        pairs.append({
            "text": f"Q: Show me all records from {tbl}\n"
                    f"A: SELECT * FROM {tbl};"
        })
        pairs.append({
            "text": f"Q: List everything in {tbl}\n"
                    f"A: SELECT * FROM {tbl};"
        })

        # SELECT specific columns
        if len(cols) >= 2:
            pairs.append({
                "text": f"Q: Get {cols[0]} and {cols[1]} from {tbl}\n"
                        f"A: SELECT {cols[0]}, {cols[1]} FROM {tbl};"
            })

        # WHERE on text column (use first text column with data)
        text_col = None
        numeric_col = None
        for c in cols[:5]:
            col_key = f"{tbl}.{c}"
            if col_types.get(col_key) == "numeric" and not numeric_col:
                numeric_col = c
            elif col_types.get(col_key) != "numeric" and not text_col:
                text_col = c

        if text_col and rows:
            # Get a sample value for WHERE
            sample_vals = set()
            for r in rows:
                v = r.get(text_col, "")
                if v and str(v).strip() and len(str(v).strip()) > 1:
                    sample_vals.add(str(v).strip())
                    if len(sample_vals) >= 3:
                        break
            for sv in list(sample_vals)[:2]:
                pairs.append({
                    "text": f"Q: Find {tbl} where {text_col} is '{sv}'\n"
                            f"A: SELECT * FROM {tbl} WHERE {text_col} = '{sv}';"
                })
                pairs.append({
                    "text": f"Q: Show {tbl} with {text_col} equal to '{sv}'\n"
                            f"A: SELECT * FROM {tbl} WHERE {text_col} = '{sv}';"
                })

        # WHERE with LIKE
        if text_col and rows:
            for r in rows[:2]:
                v = r.get(text_col, "")
                if v and str(v).strip() and len(str(v).strip()) > 2:
                    prefix = str(v).strip()[:3]
                    pairs.append({
                        "text": f"Q: Find {tbl} where {text_col} starts with '{prefix}'\n"
                                f"A: SELECT * FROM {tbl} WHERE {text_col} LIKE '{prefix}%';"
                    })
                    break

        # ORDER BY
        if numeric_col:
            pairs.append({
                "text": f"Q: List {tbl} ordered by {numeric_col} descending\n"
                        f"A: SELECT * FROM {tbl} ORDER BY {numeric_col} DESC;"
            })
            pairs.append({
                "text": f"Q: Show {tbl} sorted by {numeric_col} ascending\n"
                        f"A: SELECT * FROM {tbl} ORDER BY {numeric_col} ASC;"
            })

        # LIMIT
        pairs.append({
            "text": f"Q: Show the first 5 {tbl}\n"
                    f"A: SELECT * FROM {tbl} LIMIT 5;"
        })
        pairs.append({
            "text": f"Q: Get top 10 records from {tbl}\n"
                    f"A: SELECT * FROM {tbl} LIMIT 10;"
        })

    # ── 2. Aggregations (COUNT, SUM, AVG, GROUP BY) ────────────────────
    for key, info in table_map.items():
        tbl = key.split(".")[-1]
        cols = info["columns"]
        rows = info["rows"]

        if not cols:
            continue

        # COUNT
        pairs.append({
            "text": f"Q: How many records are in {tbl}?\n"
                    f"A: SELECT COUNT(*) FROM {tbl};"
        })
        pairs.append({
            "text": f"Q: Count the number of {tbl}\n"
                    f"A: SELECT COUNT(*) FROM {tbl};"
        })

        text_col = None
        numeric_col = None
        for c in cols[:5]:
            col_key = f"{tbl}.{c}"
            if col_types.get(col_key) == "numeric" and not numeric_col:
                numeric_col = c
            elif col_types.get(col_key) != "numeric" and not text_col:
                text_col = c

        # COUNT with WHERE
        if text_col and rows:
            for r in rows[:1]:
                v = r.get(text_col, "")
                if v and str(v).strip():
                    pairs.append({
                        "text": f"Q: Count {tbl} where {text_col} is '{str(v).strip()}'\n"
                                f"A: SELECT COUNT(*) FROM {tbl} WHERE {text_col} = '{str(v).strip()}';"
                    })
                    break

        # SUM / AVG on numeric column
        if numeric_col:
            pairs.append({
                "text": f"Q: What is the total {numeric_col} in {tbl}?\n"
                        f"A: SELECT SUM({numeric_col}) FROM {tbl};"
            })
            pairs.append({
                "text": f"Q: Calculate the average {numeric_col} in {tbl}\n"
                        f"A: SELECT AVG({numeric_col}) FROM {tbl};"
            })
            pairs.append({
                "text": f"Q: What is the minimum {numeric_col} in {tbl}?\n"
                        f"A: SELECT MIN({numeric_col}) FROM {tbl};"
            })
            pairs.append({
                "text": f"Q: What is the maximum {numeric_col} in {tbl}?\n"
                        f"A: SELECT MAX({numeric_col}) FROM {tbl};"
            })

        # GROUP BY on text column with numeric aggregate
        if text_col and numeric_col:
            pairs.append({
                "text": f"Q: Show {numeric_col} grouped by {text_col} in {tbl}\n"
                        f"A: SELECT {text_col}, SUM({numeric_col}) FROM {tbl} GROUP BY {text_col};"
            })
            pairs.append({
                "text": f"Q: Count of {tbl} by {text_col}\n"
                        f"A: SELECT {text_col}, COUNT(*) FROM {tbl} GROUP BY {text_col};"
            })
            # ORDER BY aggregate (with LIMIT for top-N)
            pairs.append({
                "text": f"Q: Top {tbl} by {numeric_col}\n"
                        f"A: SELECT {text_col}, SUM({numeric_col}) AS total FROM {tbl} GROUP BY {text_col} ORDER BY total DESC LIMIT 10;"
            })
            pairs.append({
                "text": f"Q: Top 5 {tbl} by {numeric_col}\n"
                        f"A: SELECT {text_col}, SUM({numeric_col}) AS total FROM {tbl} GROUP BY {text_col} ORDER BY total DESC LIMIT 5;"
            })
            pairs.append({
                "text": f"Q: Show the highest {numeric_col} per {text_col} in {tbl}\n"
                        f"A: SELECT {text_col}, SUM({numeric_col}) AS total FROM {tbl} GROUP BY {text_col} ORDER BY total DESC LIMIT 10;"
            })

    # ── 3. JOINs across related tables ──────────────────────────────────
    for from_tbl, to_tbl, fk_col in relationships:
        from_key = None
        to_key = None
        for k in table_map:
            if k.split(".")[-1] == from_tbl:
                from_key = k
            if k.split(".")[-1] == to_tbl:
                to_key = k

        if not from_key or not to_key:
            continue

        from_info = table_map[from_key]
        to_info = table_map[to_key]
        from_cols = from_info["columns"]
        to_cols = to_info["columns"]

        # Get a display column from the target table (non-id, text)
        to_display = None
        for c in to_cols:
            if c != fk_col and not c.endswith("_id") and not c.lower().endswith("id"):
                to_display = c
                break
        if not to_display and len(to_cols) > 1:
            to_display = to_cols[1]

        from_display = None
        for c in from_cols:
            if c != fk_col and not c.endswith("_id") and not c.lower().endswith("id"):
                from_display = c
                break
        if not from_display and len(from_cols) > 1:
            from_display = from_cols[1]

        # Simple JOIN
        pairs.append({
            "text": f"Q: Join {from_tbl} with {to_tbl}\n"
                    f"A: SELECT * FROM {from_tbl} JOIN {to_tbl} ON {from_tbl}.{fk_col} = {to_tbl}.{fk_col};"
        })

        # JOIN with selected columns
        if from_display and to_display:
            pairs.append({
                "text": f"Q: Get {from_display} from {from_tbl} with {to_display} from {to_tbl}\n"
                        f"A: SELECT {from_tbl}.{from_display}, {to_tbl}.{to_display} "
                        f"FROM {from_tbl} JOIN {to_tbl} ON {from_tbl}.{fk_col} = {to_tbl}.{fk_col};"
            })

        # JOIN with WHERE
        if from_display and to_display and from_info["rows"]:
            sample = from_info["rows"][0]
            for c in from_cols[:3]:
                v = sample.get(c, "")
                if v and str(v).strip() and not str(v).strip().isdigit():
                    pairs.append({
                        "text": f"Q: Find {to_tbl} data for {from_tbl} where {c} is '{str(v).strip()}'\n"
                                f"A: SELECT {to_tbl}.* FROM {from_tbl} "
                                f"JOIN {to_tbl} ON {from_tbl}.{fk_col} = {to_tbl}.{fk_col} "
                                f"WHERE {from_tbl}.{c} = '{str(v).strip()}';"
                    })
                    break

        # Aggregation with JOIN
        if from_display and to_display and from_info["rows"]:
            # Find a numeric column for SUM/COUNT
            to_numeric = None
            for c in to_cols[:5]:
                ck = f"{to_tbl}.{c}"
                if col_types.get(ck) == "numeric":
                    to_numeric = c
                    break
            if to_numeric:
                pairs.append({
                    "text": f"Q: Total {to_numeric} per {from_tbl} in {to_tbl}\n"
                            f"A: SELECT {from_tbl}.{from_display}, SUM({to_tbl}.{to_numeric}) "
                            f"FROM {from_tbl} JOIN {to_tbl} ON {from_tbl}.{fk_col} = {to_tbl}.{fk_col} "
                            f"GROUP BY {from_tbl}.{from_display};"
                })
            pairs.append({
                "text": f"Q: Count of {to_tbl} per {from_tbl}\n"
                        f"A: SELECT {from_tbl}.{from_display}, COUNT({to_tbl}.{fk_col}) "
                        f"FROM {from_tbl} JOIN {to_tbl} ON {from_tbl}.{fk_col} = {to_tbl}.{fk_col} "
                        f"GROUP BY {from_tbl}.{from_display};"
            })

    # ── 3b. Multi-table TOP-N with JOIN + GROUP BY + ORDER BY + LIMIT ────
    # These teach the model the critical pattern for "top N X by metric Y"
    # which requires joining multiple tables, aggregating, ordering, and limiting.

    # Detect join chains: table A → table B → table C
    # e.g., customers → orders → order_details
    join_chains = []  # [(tbl_a, tbl_b, fk_ab, tbl_c, fk_bc), ...]
    for a_tbl, b_tbl, fk_ab in relationships:
        for c_tbl, d_tbl, fk_cd in relationships:
            if b_tbl == c_tbl and a_tbl != d_tbl:
                # Found chain: a_tbl → b_tbl → d_tbl
                join_chains.append((a_tbl, b_tbl, fk_ab, d_tbl, fk_cd))

    for a_tbl, b_tbl, fk_ab, c_tbl, fk_bc in join_chains[:10]:
        a_key = b_key = c_key = None
        for k in table_map:
            short = k.split(".")[-1]
            if short == a_tbl: a_key = k
            if short == b_tbl: b_key = k
            if short == c_tbl: c_key = k

        if not (a_key and b_key and c_key):
            continue

        a_info = table_map[a_key]
        b_info = table_map[b_key]
        c_info = table_map[c_key]

        # Find display columns (non-id text columns)
        a_display = None
        for col in a_info["columns"]:
            if not col.endswith("_id") and col != "id" and col.lower() != "id":
                a_display = col
                break
        if not a_display and len(a_info["columns"]) > 1:
            a_display = a_info["columns"][1] if len(a_info["columns"]) > 1 else a_info["columns"][0]

        # Find numeric columns in the leaf table for aggregation
        c_numeric_cols = []
        for col in c_info["columns"]:
            ck = f"{c_tbl}.{col}"
            if col_types.get(ck) == "numeric":
                c_numeric_cols.append(col)

        # Find a count-able column in b_tbl (the join table)
        b_count_col = None
        for col in b_info["columns"]:
            if col.endswith("_id") or col.lower() == "id":
                b_count_col = col
                break
        if not b_count_col and b_info["columns"]:
            b_count_col = b_info["columns"][0]

        if a_display:
            # ── COUNT with JOIN chain + ORDER BY + LIMIT ──────────────
            pairs.append({
                "text": f"Q: Top 5 {a_tbl} by number of {b_tbl}\n"
                        f"A: SELECT {a_tbl}.{a_display}, COUNT({b_tbl}.{b_count_col or fk_ab}) AS cnt "
                        f"FROM {a_tbl} "
                        f"JOIN {b_tbl} ON {a_tbl}.{fk_ab} = {b_tbl}.{fk_ab} "
                        f"GROUP BY {a_tbl}.{a_display} "
                        f"ORDER BY cnt DESC LIMIT 5;"
            })
            pairs.append({
                "text": f"Q: Which {a_tbl} have the most {b_tbl}?\n"
                        f"A: SELECT {a_tbl}.{a_display}, COUNT({b_tbl}.{b_count_col or fk_ab}) AS cnt "
                        f"FROM {a_tbl} "
                        f"JOIN {b_tbl} ON {a_tbl}.{fk_ab} = {b_tbl}.{fk_ab} "
                        f"GROUP BY {a_tbl}.{a_display} "
                        f"ORDER BY cnt DESC LIMIT 10;"
            })

            # ── SUM with JOIN chain + ORDER BY + LIMIT ──────────────
            if c_numeric_cols:
                sum_col = c_numeric_cols[0]
                pairs.append({
                    "text": f"Q: Top 5 {a_tbl} by total {sum_col}\n"
                            f"A: SELECT {a_tbl}.{a_display}, SUM({c_tbl}.{sum_col}) AS total "
                            f"FROM {a_tbl} "
                            f"JOIN {b_tbl} ON {a_tbl}.{fk_ab} = {b_tbl}.{fk_ab} "
                            f"JOIN {c_tbl} ON {b_tbl}.{fk_bc} = {c_tbl}.{fk_bc} "
                            f"GROUP BY {a_tbl}.{a_display} "
                            f"ORDER BY total DESC LIMIT 5;"
                })

            # ── Semantic aliases for common patterns ──────────────────
            # "buyers" = "customers", "top buyers" = "customers with most orders"
            if a_tbl in ("customers", "customer"):
                pairs.append({
                    "text": f"Q: Top 5 buyers by order count\n"
                            f"A: SELECT {a_tbl}.{a_display}, COUNT({b_tbl}.{b_count_col or fk_ab}) AS order_count "
                            f"FROM {a_tbl} "
                            f"JOIN {b_tbl} ON {a_tbl}.{fk_ab} = {b_tbl}.{fk_ab} "
                            f"GROUP BY {a_tbl}.{a_display} "
                            f"ORDER BY order_count DESC LIMIT 5;"
                })
                pairs.append({
                    "text": f"Q: Top 5 customers by order count\n"
                            f"A: SELECT {a_tbl}.{a_display}, COUNT({b_tbl}.{b_count_col or fk_ab}) AS order_count "
                            f"FROM {a_tbl} "
                            f"JOIN {b_tbl} ON {a_tbl}.{fk_ab} = {b_tbl}.{fk_ab} "
                            f"GROUP BY {a_tbl}.{a_display} "
                            f"ORDER BY order_count DESC LIMIT 5;"
                })
                if c_numeric_cols:
                    sum_col = c_numeric_cols[0]
                    pairs.append({
                        "text": f"Q: Top 5 customers by total revenue\n"
                                f"A: SELECT {a_tbl}.{a_display}, SUM({c_tbl}.{sum_col}) AS total_revenue "
                                f"FROM {a_tbl} "
                                f"JOIN {b_tbl} ON {a_tbl}.{fk_ab} = {b_tbl}.{fk_ab} "
                                f"JOIN {c_tbl} ON {b_tbl}.{fk_bc} = {c_tbl}.{fk_bc} "
                                f"GROUP BY {a_tbl}.{a_display} "
                                f"ORDER BY total_revenue DESC LIMIT 5;"
                    })
                    pairs.append({
                        "text": f"Q: Top 5 buyers by total spend\n"
                                f"A: SELECT {a_tbl}.{a_display}, SUM({c_tbl}.{sum_col}) AS total_spend "
                                f"FROM {a_tbl} "
                                f"JOIN {b_tbl} ON {a_tbl}.{fk_ab} = {b_tbl}.{fk_ab} "
                                f"JOIN {c_tbl} ON {b_tbl}.{fk_bc} = {c_tbl}.{fk_bc} "
                                f"GROUP BY {a_tbl}.{a_display} "
                                f"ORDER BY total_spend DESC LIMIT 5;"
                    })

    # ── 4. DISTINCT / IN / BETWEEN / Complex ────────────────────────────
    for key, info in table_map.items():
        tbl = key.split(".")[-1]
        cols = info["columns"]

        text_col = None
        numeric_col = None
        for c in cols[:5]:
            ck = f"{tbl}.{c}"
            if col_types.get(ck) == "numeric" and not numeric_col:
                numeric_col = c
            elif col_types.get(ck) != "numeric" and not text_col:
                text_col = c

        # DISTINCT
        if text_col:
            pairs.append({
                "text": f"Q: List unique {text_col} values in {tbl}\n"
                        f"A: SELECT DISTINCT {text_col} FROM {tbl};"
            })

        # BETWEEN (if numeric column exists)
        if numeric_col and info["rows"]:
            num_vals = []
            for r in info["rows"]:
                try:
                    num_vals.append(float(r.get(numeric_col, 0)))
                except (ValueError, TypeError):
                    pass
            if len(num_vals) >= 2:
                min_v = min(num_vals)
                max_v = max(num_vals)
                mid = (min_v + max_v) / 2
                pairs.append({
                    "text": f"Q: Find {tbl} where {numeric_col} is between {min_v:.0f} and {mid:.0f}\n"
                            f"A: SELECT * FROM {tbl} WHERE {numeric_col} BETWEEN {min_v:.0f} AND {mid:.0f};"
                })

        # IN clause
        if text_col and info["rows"]:
            vals = []
            for r in info["rows"][:3]:
                v = r.get(text_col, "")
                if v and str(v).strip():
                    vals.append(f"'{str(v).strip()}'")
            if len(vals) >= 2:
                pairs.append({
                    "text": f"Q: Find {tbl} where {text_col} is one of specific values\n"
                            f"A: SELECT * FROM {tbl} WHERE {text_col} IN ({', '.join(vals)});"
                })

        # IS NULL
        pairs.append({
            "text": f"Q: Find {tbl} with missing {cols[0]}\n"
                    f"A: SELECT * FROM {tbl} WHERE {cols[0]} IS NULL;"
        })

    print(f"   Generated {len(pairs)} Text-to-SQL training pairs")
    sys.stdout.flush()
    return pairs


# ─── DPO Preference Pair Generator ────────────────────────────────────────────
# Creates (prompt, chosen, rejected) triples from Q&A data for DPO training.
# The model learns to prefer correct (data-backed) answers over wrong ones.

def _generate_dpo_pairs(qa_pairs):
    """
    qa_pairs: list of {"text": "Q: ... A: ..."} from _generate_db_qa_pairs
    Returns: Dataset with columns ["prompt", "chosen", "rejected"]
    """
    dpo_data = []
    import random

    for pair in qa_pairs:
        text = pair["text"]
        if "Q: " not in text or "A: " not in text:
            continue
        # Split on first Q: and A:
        parts = text.split("A: ", 1)
        if len(parts) != 2:
            continue
        prompt_part = parts[0].strip()  # "Q: ..."
        chosen = parts[1].strip()       # correct answer

        # Ensure prompt ends with a clear indicator
        if not prompt_part.endswith("\nA"):
            prompt_part = prompt_part + "\nA"

        # Generate a plausible wrong answer (rejected)
        chosen_lower = chosen.lower()

        # Strategy: pick a meaningful wrong answer based on content
        if "there are" in chosen_lower and "orders" in chosen_lower:
            # Wrong count: inflate the number
            rejected = "I don't have the exact order count in my training data."
        elif "there are" in chosen_lower and ("product" in chosen_lower or "customer" in chosen_lower or "employee" in chosen_lower or "supplier" in chosen_lower):
            rejected = "I'm not sure about the exact count. Let me check my knowledge base."
        elif "$" in chosen:
            # Price question: wrong price
            rejected = "That product's pricing information is not available in my training data."
        elif "orders" in chosen_lower and "customer" in chosen_lower:
            rejected = "I cannot find specific order information for that customer."
        elif "category" in chosen_lower:
            rejected = "I don't have information about product categories."
        elif "territor" in chosen_lower or "region" in chosen_lower:
            rejected = "I don't have the territory or region data available."
        elif "employee" in chosen_lower:
            rejected = "I don't have employee records in my knowledge base."
        elif "supplier" in chosen_lower:
            rejected = "Supplier information is not available in my training data."
        elif "shipper" in chosen_lower:
            rejected = "I don't have shipping company data."
        elif chosen.startswith("SELECT") or "SELECT" in chosen:
            # SQL query — wrong answer is a wrong SQL or refuse
            sql_rejections = [
                "SELECT * FROM information_schema.tables;",
                "I'm not able to write SQL queries.",
                "SELECT COUNT(*) FROM users;",
                "I don't know how to query that data.",
                "SELECT * FROM unknown_table;",
            ]
            rejected = random.choice(sql_rejections)
        else:
            # Generic wrong answer
            rejections = [
                "I don't have that information in my knowledge base.",
                "That data is not available in my training set.",
                "I cannot answer that question based on my training data.",
                "I'm not trained on that specific database information.",
            ]
            rejected = random.choice(rejections)

        dpo_data.append({
            "prompt": prompt_part,
            "chosen": chosen,
            "rejected": rejected,
        })

    print(f"   Generated {len(dpo_data)} DPO preference pairs")
    sys.stdout.flush()
    return dpo_data


# ─── DPO Training Phase ──────────────────────────────────────────────────────
# Runs after SFT to teach the model to prefer correct answers over wrong ones.
# This is reinforcement learning via direct preference optimization.

def _run_cpu_dpo(model, tokenizer, qa_pairs, lora_config, model_name, log_callback=print):
    """
    model: the SFT-trained PeftModel
    tokenizer: the tokenizer
    qa_pairs: list of {"text": "Q: ... A: ..."} from _generate_db_qa_pairs
    lora_config: the LoraConfig to re-apply (DPOTrainer can take peft_config)
    """
    try:
        from trl import DPOTrainer, DPOConfig
        from datasets import Dataset
        import torch

        log_callback("🧠 Starting DPO reinforcement learning phase...")
        log_callback("   Teaching model to prefer correct answers over hallucinated ones...")
        sys.stdout.flush()

        # Generate preference pairs
        dpo_dataset = _generate_dpo_pairs(qa_pairs)

        if len(dpo_dataset) < 2:
            log_callback("   ⚠ Not enough pairs for DPO (need at least 2). Skipping.")
            return

        dpo_dataset_hf = Dataset.from_list(dpo_dataset)

        log_callback(f"   DPO dataset: {len(dpo_dataset_hf)} preference pairs")
        sys.stdout.flush()

        # For CPU training, we need to handle the model carefully.
        # The SFT model already has LoRA applied. We pass peft_config to DPOTrainer
        # so it can re-initialize the adapter for preference tuning.
        # We use a very low learning rate to not destroy SFT knowledge.
        dpo_trainer = DPOTrainer(
            model=model,
            processing_class=tokenizer,
            train_dataset=dpo_dataset_hf,
            peft_config=lora_config,
            args=DPOConfig(
                output_dir=f"/tmp/kuvalam_dpo_{model_name}",
                per_device_train_batch_size=1,
                gradient_accumulation_steps=2,
                max_steps=15,  # fewer steps than SFT
                learning_rate=1e-5,  # lower LR — fine-tune preferences gently
                logging_steps=1,
                optim="adamw_torch",
                weight_decay=0.01,
                seed=3407,
                dataloader_pin_memory=False,
                use_cpu=True,
                max_length=512,
                remove_unused_columns=True,
                beta=0.1,  # DPO temperature — higher = more focus on preference
                loss_type=["sigmoid"],  # standard DPO loss
            ),
        )

        log_callback("🚀 Starting DPO training loop...")
        sys.stdout.flush()
        dpo_trainer.train()
        log_callback("✅ DPO training complete! Model now prefers correct answers.")
        sys.stdout.flush()

    except ImportError as e:
        log_callback(f"   ⚠ DPO dependencies not available: {e}. Skipping DPO phase.")
        sys.stdout.flush()
    except Exception as e:
        log_callback(f"   ⚠ DPO training failed: {e}. SFT model was saved — DPO is bonus.")
        sys.stdout.flush()
        import traceback
        traceback.print_exc()


# ─── CPU Training Path (no GPU, no Unsloth) ──────────────────────────────────
# Uses standard transformers + peft + trl for small models (≤2B params).
# Slower than GPU but produces real LoRA fine-tuning results.

def _run_cpu_training(args):
    print("🧠 CPU training mode activated — setting up transformers + PEFT + TRL...")
    print(f"⚠️  This will be slow. For faster training, install PyTorch with CUDA.")
    print("   Loading model (this may take a while on CPU)...")
    sys.stdout.flush()

    try:
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer
        from peft import LoraConfig, TaskType
        from trl import SFTTrainer, SFTConfig
        from datasets import Dataset, load_dataset
        import pandas as pd

        device = "cpu"
        print(f"   Using device: {device}")
        sys.stdout.flush()

        model_id = _resolve_model_id(args.base)
        print(f"   Resolved model: {args.base} → {model_id}")
        sys.stdout.flush()

        # Load tokenizer
        print(f"   Loading tokenizer for {model_id}...")
        sys.stdout.flush()
        tokenizer = AutoTokenizer.from_pretrained(model_id, use_fast=True)
        if tokenizer.pad_token is None:
            tokenizer.pad_token = tokenizer.eos_token

        # Load model in float32 (no 4-bit — that requires CUDA/bitsandbytes)
        print(f"   Loading model {model_id} in float32 (this may take a while)...")
        sys.stdout.flush()
        model = AutoModelForCausalLM.from_pretrained(
            model_id,
            torch_dtype=torch.float32,
            device_map=None,  # run on CPU
            low_cpu_mem_usage=True,
        )

        # Define LoRA config (will be applied by SFTTrainer via peft_config)
        print("   Setting up LoRA configuration...")
        sys.stdout.flush()
        lora_config = LoraConfig(
            r=16,
            lora_alpha=16,
            target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
            lora_dropout=0,
            bias="none",
            task_type=TaskType.CAUSAL_LM,
        )

        # Build dataset
        qa_pairs = []   # populated for database source; used for DPO preference training
        sql_pairs = []  # populated for database source; Text-to-SQL pairs

        if args.datasource == 'file':
            print(f"📂 Loading file: {args.dataset}")
            sys.stdout.flush()
            if str(args.dataset).endswith('.jsonl') or str(args.dataset).endswith('.json'):
                dataset = load_dataset("json", data_files=args.dataset, split="train")
            else:
                from langchain_community.document_loaders import UnstructuredFileLoader
                loader = UnstructuredFileLoader(args.dataset)
                docs = loader.load()
                df = pd.DataFrame([{"text": doc.page_content} for doc in docs])
                dataset = Dataset.from_pandas(df)
        elif args.datasource == 'database':
            print(f"🗄️  Loading from database...")
            sys.stdout.flush()
            import sqlalchemy
            engine = sqlalchemy.create_engine(args.db_url)
            if args.db_query and args.db_query.strip():
                print(f"   Executing query: {args.db_query[:80]}...")
                sys.stdout.flush()
                with engine.connect() as conn:
                    df = pd.read_sql(args.db_query, conn)
                dataset = Dataset.from_pandas(df)
            else:
                # No explicit query — extract all rows from all tables
                print("   No SQL query provided. Extracting all data from database...")
                sys.stdout.flush()
                with engine.connect() as conn:
                    tables = conn.execute(
                        sqlalchemy.text(
                            "SELECT table_schema, table_name FROM information_schema.tables "
                            "WHERE table_schema NOT IN ('pg_catalog', 'information_schema')"
                        )
                    ).fetchall()

                # Collect structured data for ontology + Q&A generation
                all_tables_data = []  # (schema, table, col_names, rows_dict_list)

                for schema, table in tables:
                    full_name = f'"{schema}"."{table}"' if schema != 'public' else f'"{table}"'
                    try:
                        with engine.connect() as conn:
                            # Get column names
                            col_names = [desc[0] for desc in conn.execute(sqlalchemy.text(f'SELECT * FROM {full_name} LIMIT 0')).cursor.description]
                            # Get all rows (small DB) or limit to 500
                            data = conn.execute(sqlalchemy.text(f'SELECT * FROM {full_name} LIMIT 500')).fetchall()

                        # Build row dicts for ontology + Q&A generation
                        row_dicts = []
                        for row in data:
                            row_dict = dict(zip(col_names, [str(v) if v is not None else '' for v in row]))
                            row_dicts.append(row_dict)

                        all_tables_data.append((schema, table, col_names, row_dicts))

                        print(f"   ✓ {schema}.{table}: {len(data)} rows")
                        sys.stdout.flush()
                    except Exception as e:
                        print(f"   ⚠ Skipping {schema}.{table}: {e}")
                        sys.stdout.flush()

                # ── Generate ontology training data (replaces raw row dumps) ──
                # The ontology teaches the model the schema structure, classes,
                # properties, relationships, and instance triples — not just
                # memorized values. This enables relational reasoning.
                ontology_data = []
                try:
                    ontology_data = _generate_ontology_training_data(
                        all_tables_data,
                        args.db_url.split('@')[-1] if '@' in args.db_url else 'db'
                    )
                except Exception as e:
                    print(f"⚠️ _generate_ontology_training_data failed: {e}")
                    import traceback
                    traceback.print_exc()
                    ontology_data = []

                # Generate Q&A training pairs from the extracted data
                try:
                    qa_pairs = _generate_db_qa_pairs(all_tables_data, args.db_url.split('@')[-1] if '@' in args.db_url else 'db')
                except Exception as e:
                    print(f"⚠️ _generate_db_qa_pairs failed: {e}")
                    import traceback
                    traceback.print_exc()
                    qa_pairs = []

                # Generate Text-to-SQL training pairs (generic — works for any schema)
                try:
                    sql_pairs = _generate_text_to_sql_pairs(all_tables_data)
                except Exception as e:
                    print(f"⚠️ _generate_text_to_sql_pairs failed: {e}")
                    import traceback
                    traceback.print_exc()
                    sql_pairs = []

                # Combine: ontology (structure + triples) + Q&A + Text-to-SQL
                combined = ontology_data + qa_pairs + sql_pairs
                df = pd.DataFrame(combined) if combined else pd.DataFrame({"text": ["No data found"]})

            dataset = Dataset.from_pandas(df)
            print(f"   Total: {len(dataset)} rows loaded (ontology + Q&A + Text-to-SQL)")
            sys.stdout.flush()
        elif args.datasource == 'web':
            print(f"🌐 Loading from web: {args.web_url}")
            sys.stdout.flush()
            import requests
            resp = requests.get(args.web_url)
            text = resp.text[:10000]
            df = pd.DataFrame([{"text": text}])
            dataset = Dataset.from_pandas(df)
        elif args.datasource == 'nosql':
            print(f"📦 Loading MongoDB schema from: {args.nosql_jsonl}")
            sys.stdout.flush()
            import json as _json
            try:
                with open(args.nosql_jsonl, 'r') as f:
                    mongo_data = _json.load(f)
            except Exception as e:
                print(f"⚠️ Failed to read NoSQL JSONL: {e}")
                sys.stdout.flush()
                mongo_data = {"collections": []}

            collections = mongo_data.get("collections", [])
            print(f"   Found {len(collections)} collections: {[c['collection'] for c in collections]}")
            sys.stdout.flush()

            # Generate MongoDB Q&A training pairs
            try:
                mongo_qa_pairs = _generate_mongo_qa_pairs(collections)
                print(f"   ✓ Generated {len(mongo_qa_pairs)} MongoDB Q&A pairs")
            except Exception as e:
                print(f"⚠️ _generate_mongo_qa_pairs failed: {e}")
                import traceback
                traceback.print_exc()
                mongo_qa_pairs = []

            # Generate MongoDB aggregation pipeline training pairs
            try:
                mongo_agg_pairs = _generate_mongo_aggregation_pairs(collections)
                print(f"   ✓ Generated {len(mongo_agg_pairs)} MongoDB aggregation pairs")
            except Exception as e:
                print(f"⚠️ _generate_mongo_aggregation_pairs failed: {e}")
                import traceback
                traceback.print_exc()
                mongo_agg_pairs = []

            combined = mongo_qa_pairs + mongo_agg_pairs
            df = pd.DataFrame(combined) if combined else pd.DataFrame({"text": ["No data found"]})
            dataset = Dataset.from_pandas(df)
            print(f"   Total: {len(dataset)} rows (MongoDB Q&A + aggregations)")
            sys.stdout.flush()
        else:
            # No real data — create a minimal dummy dataset to exercise the pipeline
            print("📝 No data source provided — using minimal training sample.")
            df = pd.DataFrame([{"text": "Hello world"}])
            dataset = Dataset.from_pandas(df)

        print(f"📊 Dataset has {len(dataset)} rows")
        if len(dataset) > 0:
            print(f"   Sample: {dataset[0]['text'][:100]}...")
        sys.stdout.flush()

        # Train on CPU — fewer steps, smaller batch, no fp16/bf16
        # Using TRL 1.9.0+ API: processing_class replaces tokenizer,
        # peft_config is passed directly to SFTTrainer,
        # dataset_text_field and max_length go in SFTConfig.
        trainer = SFTTrainer(
            model=model,
            processing_class=tokenizer,
            train_dataset=dataset,
            peft_config=lora_config,
            args=SFTConfig(
                output_dir="/tmp/kuvalam_cpu_train",
                per_device_train_batch_size=1,
                gradient_accumulation_steps=2,
                warmup_steps=5,
                max_steps=30,
                learning_rate=2e-4,
                logging_steps=1,
                optim="adamw_torch",
                weight_decay=0.01,
                lr_scheduler_type="linear",
                seed=3407,
                dataloader_pin_memory=False,
                use_cpu=True,
                dataset_text_field="text",
                max_length=512,
                remove_unused_columns=True,
            ),
        )

        print("🚀 Starting CPU training loop...")
        sys.stdout.flush()
        trainer.train()
        print("✅ CPU training complete!")
        sys.stdout.flush()

        # ── Phase 2: DPO Reinforcement Learning ──────────────────────────
        # After SFT (teaching format), run DPO to teach the model to PREFER
        # correct answers over wrong ones — like learning from trial and error.
        all_pairs_for_dpo = qa_pairs + sql_pairs
        if all_pairs_for_dpo:
            print(f"   🧠 Starting DPO phase with {len(all_pairs_for_dpo)} preference pairs...")
            sys.stdout.flush()
            _run_cpu_dpo(model, tokenizer, all_pairs_for_dpo, lora_config, args.name,
                         lambda msg: (print(msg), sys.stdout.flush()))
        else:
            print("   ⏭ No training pairs available — skipping DPO phase.")
            sys.stdout.flush()

        # Save LoRA adapter (not GGUF — that needs Unsloth or convert script)
        # Use a persistent path relative to the trainer script, not /tmp (lost on reboot).
        # The Node.js pushToOllama handler looks for this directory.
        output_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..', 'trained_models', args.name)
        os.makedirs(output_path, exist_ok=True)
        model.save_pretrained(output_path)
        tokenizer.save_pretrained(output_path)
        print(f"💾 LoRA adapter saved to {output_path}")

        print(f"🎉 Model {args.name} successfully trained on CPU!")
        print(f"   To use: load base model '{args.base}' with adapter '{output_path}'")
        sys.stdout.flush()
        sys.exit(0)

    except Exception as e:
        print(f"❌ CPU training failed: {e}")
        sys.stdout.flush()
        sys.exit(1)  # Exit with error so Node.js side sets status to FAILED

# ─── MongoDB Q&A Pair Generator ────────────────────────────────────────────
# Generates natural-language Q&A pairs from MongoDB collection document samples.
# Works for ANY MongoDB database — auto-detects collections, fields, types.
def _generate_mongo_qa_pairs(collections):
    """Generate Q&A training pairs from MongoDB collection data.

    Args:
        collections: list of {collection, totalDocuments, sampleCount, fields, documents}

    Returns list of {"text": "Q: ...\\nA: ..."} dicts.
    """
    pairs = []

    for coll in collections:
        col_name = coll["collection"]
        total_docs = coll.get("totalDocuments", 0)
        fields = coll.get("fields", [])
        documents = coll.get("documents", [])

        # ── Basic collection info ──────────────────────────────────────
        pairs.append({"text": f"Q: How many documents are in the {col_name} collection?\nA: There are {total_docs} documents in the {col_name} collection."})
        pairs.append({"text": f"Q: What fields does the {col_name} collection have?\nA: The {col_name} collection has these fields: " +
            ", ".join(f"{f['name']} ({' | '.join(f['types'])})" for f in fields[:15]) +
            (f" ... ({len(fields)} total fields)" if len(fields) > 15 else "")})

        # ── Field type questions ───────────────────────────────────────
        for f in fields[:8]:
            name = f["name"]
            types = f["types"]
            pairs.append({"text": f"Q: What type is the {name} field in {col_name}?\nA: The {name} field in {col_name} is of type {types[0]}."})

        # ── Document count questions ───────────────────────────────────
        if total_docs > 0:
            pairs.append({"text": f"Q: How many records does {col_name} contain?\nA: The {col_name} collection contains {total_docs} records."})
            pairs.append({"text": f"Q: What is the size of {col_name}?\nA: The {col_name} collection has {total_docs} documents."})

        # ── Per-document Q&A ───────────────────────────────────────────
        for doc in documents[:10]:
            # Find the best "name-like" field for identification
            display_field = None
            display_value = None
            for f in fields:
                fn = f["name"].lower()
                if fn in ("name", "title", "label", "description", "email", "username", "_id"):
                    val = doc.get(f["name"], "")
                    if val and str(val).strip():
                        display_field = f["name"]
                        display_value = val
                        break
            if not display_field:
                # Pick first non-empty string field
                for k, v in list(doc.items())[:6]:
                    if v and isinstance(v, str) and v.strip():
                        display_field = k
                        display_value = v
                        break

            if display_field and display_value:
                # List all fields for this document
                fields_str = ", ".join(
                    f"{k}={str(v)[:60]}" + ("..." if len(str(v)) > 60 else "")
                    for k, v in list(doc.items())[:8]
                )
                pairs.append({"text": f"Q: Find {col_name} where {display_field}={display_value}\nA: {fields_str}"})
                pairs.append({"text": f"Q: What is {display_value} in {col_name}?\nA: {display_value}: {fields_str}"})
                break  # one doc per collection for lookup-style questions

        # ── Count by field (for fields with few unique values) ─────────
        for f in fields[:3]:
            name = f["name"]
            val_counts = {}
            for doc in documents:
                v = str(doc.get(name, "")).strip()
                if v:
                    val_counts[v] = val_counts.get(v, 0) + 1

            if 2 <= len(val_counts) <= 12:
                counts_str = "; ".join(f"{k}: {v}" for k, v in
                    sorted(val_counts.items(), key=lambda x: -x[1])[:10])
                pairs.append({"text": f"Q: How many {col_name} per {name}?\nA: " + counts_str})

                most_common = max(val_counts, key=val_counts.get)
                pairs.append({"text": f"Q: What is the most common {name} in {col_name}?\nA: The most common {name} in {col_name} is '{most_common}' with {val_counts[most_common]} documents."})
                break  # one per collection

        # ── Numeric field aggregates ──────────────────────────────────
        for f in fields:
            ftypes = f["types"]
            if "integer" in ftypes or "float" in ftypes:
                name = f["name"]
                nums = []
                for doc in documents:
                    try:
                        v = doc.get(name)
                        if v is not None and v != "":
                            nums.append(float(v))
                    except (ValueError, TypeError):
                        pass
                if nums and len(nums) > len(documents) * 0.3:
                    total = sum(nums)
                    avg = total / len(nums)
                    pairs.append({"text": f"Q: What is the total {name} across {col_name}?\nA: The total {name} in {col_name} is {total:,.2f}."})
                    pairs.append({"text": f"Q: What is the average {name} in {col_name}?\nA: The average {name} in {col_name} is {avg:,.2f}."})
                    # Min/max
                    min_val = min(nums)
                    max_val = max(nums)
                    pairs.append({"text": f"Q: What is the range of {name} in {col_name}?\nA: The {name} in {col_name} ranges from {min_val:,.2f} to {max_val:,.2f}."})
                    break  # one aggregate per collection

        # ── Top-N by numeric field ─────────────────────────────────────
        for f in fields:
            ftypes = f["types"]
            if "integer" in ftypes or "float" in ftypes:
                name = f["name"]
                # Find display field
                display_f = None
                for df in fields:
                    dfn = df["name"].lower()
                    if dfn in ("name", "title", "label", "_id", "email", "username"):
                        display_f = df["name"]
                        break
                if not display_f:
                    display_f = list(doc.keys())[0] if documents and documents[0] else None

                if display_f and documents:
                    ranked = []
                    for doc in documents:
                        try:
                            v = doc.get(name)
                            if v is not None and v != "":
                                ranked.append((doc.get(display_f, str(doc)), float(v)))
                        except (ValueError, TypeError):
                            pass
                    ranked.sort(key=lambda x: -x[1])
                    top5 = ranked[:5]
                    if top5:
                        top5_str = "; ".join(
                            f"#{i+1} {label} — {val:,.2f}"
                            for i, (label, val) in enumerate(top5)
                        )
                        pairs.append({"text": f"Q: Top 5 {col_name} by {name}\nA: {top5_str}"})
                        pairs.append({"text": f"Q: Which {col_name} has the highest {name}?\nA: {top5_str}"})
                break

        # ── Array field questions ──────────────────────────────────────
        for f in fields:
            if "array" in f["types"]:
                name = f["name"]
                # Count docs with this array field
                has_array = sum(1 for doc in documents if isinstance(doc.get(name), list))
                if has_array > 0:
                    pairs.append({"text": f"Q: How many {col_name} have {name} populated?\nA: {has_array} out of {len(documents)} sampled {col_name} documents have {name} populated."})

                    # Average array length
                    lengths = [len(doc[name]) for doc in documents if isinstance(doc.get(name), list)]
                    if lengths:
                        avg_len = sum(lengths) / len(lengths)
                        pairs.append({"text": f"Q: What is the average number of items in {name} for {col_name}?\nA: On average, {col_name} documents have {avg_len:.1f} items in {name}."})
                break

        # ── Date field questions ───────────────────────────────────────
        for f in fields:
            if "date" in f["types"]:
                name = f["name"]
                dates = []
                for doc in documents:
                    v = doc.get(name)
                    if v:
                        try:
                            from datetime import datetime
                            if isinstance(v, str):
                                d = datetime.fromisoformat(v.replace("Z", "+00:00"))
                                dates.append(d)
                        except:
                            pass
                if dates:
                    dates.sort()
                    earliest = dates[0].strftime("%Y-%m-%d")
                    latest = dates[-1].strftime("%Y-%m-%d")
                    pairs.append({"text": f"Q: What date range does {col_name} cover?\nA: {col_name} spans from {earliest} to {latest}."})
                break

    return pairs


# ─── MongoDB Aggregation Pipeline Pair Generator ────────────────────────────
# Generates training pairs that teach the model to write MongoDB aggregation
# pipelines (the NoSQL equivalent of SQL queries).
def _mongo_pipeline(*parts):
    """Build a MongoDB pipeline string — avoids f-string brace escaping."""
    return ''.join(str(p) for p in parts)


def _generate_mongo_aggregation_pairs(collections):
    """Generate MongoDB aggregation pipeline training pairs.

    Each pair is a Q&A where the answer is a valid aggregation pipeline.
    This teaches the model to write: db.collection.aggregate([...])

    Returns list of {"text": "Q: ...\\nA: ..."} dicts.
    """
    pairs = []

    for coll in collections:
        col_name = coll["collection"]
        fields = coll.get("fields", [])
        documents = coll.get("documents", [])

        if not fields or not documents:
            continue

        field_names = [f["name"] for f in fields]
        field_types = {f["name"]: f["types"] for f in fields}

        # ── Count all ──────────────────────────────────────────────────
        pipeline = "db.{0}.aggregate([{1} $count: 'total' {2}])".format(col_name, '{', '}')
        pairs.append({"text": "Q: MongoDB aggregation to count documents in {0}\nA: {1}".format(col_name, pipeline)})

        # ── Group by categorical field ─────────────────────────────────
        for f in fields[:3]:
            fname = f["name"]
            if fname in ("_id", "$oid", "id"):
                continue
            vals = set()
            for doc in documents:
                v = str(doc.get(fname, "")).strip()
                if v:
                    vals.add(v)
            if 2 <= len(vals) <= 15:
                # db.X.aggregate([{ $group: { _id: '$fn', count: { $sum: 1 } } }, { $sort: { count: -1 } }])
                pipeline = "db.{0}.aggregate([{1} $group: {1} _id: '${2}', count: {1} $sum: 1 {3} {3}, {1} $sort: {1} count: -1 {3} {3}])".format(
                    col_name, '{', fname, '}')
                pairs.append({"text": "Q: MongoDB aggregation to count {0} grouped by {1}\nA: {2}".format(col_name, fname, pipeline)})
                pairs.append({"text": "Q: How to group {0} by {1} in MongoDB?\nA: Use {2}".format(col_name, fname, pipeline)})
                break

        # ── Numeric aggregations (sum, avg, min, max) ───────────────────
        for f in fields:
            fname = f["name"]
            ftypes = f["types"]
            if fname.startswith("_"):
                continue
            if "integer" in ftypes or "float" in ftypes:
                # avg
                pipeline_avg = "db.{0}.aggregate([{1} $group: {1} _id: null, avg_{2}: {1} $avg: '${2}' {3} {3}])".format(
                    col_name, '{', fname, '}')
                pairs.append({"text": "Q: MongoDB aggregation to get average {0} in {1}\nA: {2}".format(fname, col_name, pipeline_avg)})

                # sum
                pipeline_sum = "db.{0}.aggregate([{1} $group: {1} _id: null, total_{2}: {1} $sum: '${2}' {3} {3}])".format(
                    col_name, '{', fname, '}')
                pairs.append({"text": "Q: MongoDB aggregation for total {0} in {1}\nA: {2}".format(fname, col_name, pipeline_sum)})

                # min/max
                pipeline_minmax = "db.{0}.aggregate([{1} $group: {1} _id: null, min_{2}: {1} $min: '${2}' {3}, max_{2}: {1} $max: '${2}' {3} {3}])".format(
                    col_name, '{', fname, '}')
                pairs.append({"text": "Q: MongoDB pipeline to get min and max {0} in {1}\nA: {2}".format(fname, col_name, pipeline_minmax)})

                # Top 5
                pipeline_top5 = "db.{0}.aggregate([{1} $sort: {1} {2}: -1 {3} {3}, {1} $limit: 5 {3}, {1} $project: {1} _id: 0, name: 1, {2}: 1 {3} {3}])".format(
                    col_name, '{', fname, '}')
                pairs.append({"text": "Q: MongoDB aggregation to get top 5 {0} by {1}\nA: {2}".format(col_name, fname, pipeline_top5)})

                pipeline_top1 = "db.{0}.aggregate([{1} $sort: {1} {2}: -1 {3} {3}, {1} $limit: 1 {3}])".format(
                    col_name, '{', fname, '}')
                pairs.append({"text": "Q: How to find the {0} with the highest {1}?\nA: {2}".format(col_name, fname, pipeline_top1)})
                break

        # ── Project / filter examples ───────────────────────────────────
        if len(field_names) >= 3:
            f1, f2 = field_names[0], field_names[1]
            pipeline_proj = "db.{0}.aggregate([{1} $project: {1} _id: 0, {2}: 1, {3}: 1 {4} {4}])".format(
                col_name, '{', f1, f2, '}')
            pairs.append({"text": "Q: MongoDB aggregation to project {0} and {1} from {2}\nA: {3}".format(f1, f2, col_name, pipeline_proj)})

        # ── Match/filter on a string field ──────────────────────────────
        for f in fields:
            fname = f["name"]
            ftypes = f["types"]
            if "string" in ftypes and not fname.startswith("_"):
                sample_val = None
                for doc in documents:
                    v = doc.get(fname, "")
                    if v and isinstance(v, str) and v.strip():
                        sample_val = v.strip()
                        break
                if sample_val:
                    safe_val = sample_val.replace("'", "\\'")[:40]
                    pairs.append({"text":
                        "Q: MongoDB query to find {0} where {1} equals '{2}'\n"
                        "A: db.{0}.find({1} {3}: '{2}' {4})\n"
                        "   Or with aggregation: db.{0}.aggregate([{1} $match: {1} {3}: '{2}' {4} {4}])".format(
                            col_name, '{', safe_val, fname, '}')})
                break

        # ── $unwind array fields ────────────────────────────────────────
        for f in fields:
            fname = f["name"]
            ftypes = f["types"]
            if "array" in ftypes:
                pipeline_unwind = "db.{0}.aggregate([{1} $unwind: '${2}' {3}, {1} $group: {1} _id: '${2}', count: {1} $sum: 1 {3} {3}])".format(
                    col_name, '{', fname, '}')
                pairs.append({"text": "Q: MongoDB aggregation to unwind the {0} array in {1}\nA: {2}".format(fname, col_name, pipeline_unwind)})

                pipeline_flat = "db.{0}.aggregate([{1} $unwind: '${2}' {3}])".format(col_name, '{', fname, '}')
                pairs.append({"text": "Q: How to flatten {0} array in {1} MongoDB?\nA: Use {2}".format(fname, col_name, pipeline_flat)})
                break

        # ── Date range filter ──────────────────────────────────────────
        for f in fields:
            fname = f["name"]
            ftypes = f["types"]
            if "date" in ftypes:
                pipeline_date = "db.{0}.aggregate([{1} $match: {1} {2}: {1} $gte: ISODate('2024-01-01'), $lte: ISODate('2024-12-31') {3} {3} {3}])".format(
                    col_name, '{', fname, '}')
                pairs.append({"text": "Q: MongoDB aggregation to filter {0} by date range on {1}\nA: {2}".format(col_name, fname, pipeline_date)})
                break

        # ── Pipeline with multiple stages (Match → Group → Sort) ────────
        for f in fields:
            fname = f["name"]
            ftypes = f["types"]
            if "string" in ftypes and not fname.startswith("_"):
                pairs.append({"text":
                    "Q: MongoDB pipeline to match, group by {0}, and count in {1}\n"
                    "A: db.{1}.aggregate([\n"
                    "  {2} $match: {2} status: 'active' {3} {3},\n"
                    "  {2} $group: {2} _id: '${0}', count: {2} $sum: 1 {3} {3},\n"
                    "  {2} $sort: {2} count: -1 {3} {3}\n])".format(fname, col_name, '{', '}')})
                break

        # ── $lookup (join) patterns ─────────────────────────────────────
        for f in fields:
            fname = f["name"]
            if fname.endswith("_id") and fname != "_id":
                ref_coll = fname[:-3]  # e.g., "user_id" → "user"
                pipeline_lookup_unwind = "db.{0}.aggregate(["
                pipeline_lookup_unwind += "{1} $lookup: {1} from: '{2}', localField: '{3}', foreignField: '_id', as: '{2}' {4} {4}, "
                pipeline_lookup_unwind += "{1} $unwind: '${2}' {4}])"
                pipeline_lookup_unwind = pipeline_lookup_unwind.format(col_name, '{', ref_coll, fname, '}')
                pairs.append({"text": "Q: MongoDB aggregation with $lookup from {0} to {1}\nA: {2}".format(col_name, ref_coll, pipeline_lookup_unwind)})

                pipeline_lookup = "db.{0}.aggregate([{1} $lookup: {1} from: '{2}', localField: '{3}', foreignField: '_id', as: '{2}' {4} {4}])".format(
                    col_name, '{', ref_coll, fname, '}')
                pairs.append({"text": "Q: How to join {0} with {1} in MongoDB?\nA: Use {2}".format(col_name, ref_coll, pipeline_lookup)})
                break

        # ── Faceted search (multiple groups in one pipeline) ────────────
        pipeline_facet = "db.{0}.aggregate([{1} $facet: {1} total: [{1} $count: 'count' {2}], groups: [{1} $group: {1} _id: '$status', count: {1} $sum: 1 {2} {2}] {2} {2}])".format(
            col_name, '{', '}')
        pairs.append({"text": "Q: MongoDB facet aggregation to get multiple stats for {0}\nA: {1}".format(col_name, pipeline_facet)})

        # ── $addFields / computed fields ────────────────────────────────
        for f in fields:
            fname = f["name"]
            ftypes = f["types"]
            if "integer" in ftypes or "float" in ftypes:
                pipeline_add = "db.{0}.aggregate([{1} $addFields: {1} doubled_{2}: {1} $multiply: ['${2}', 2] {3} {3} {3}])".format(
                    col_name, '{', fname, '}')
                pairs.append({"text": "Q: MongoDB aggregation to add a computed field doubling {0} in {1}\nA: {2}".format(fname, col_name, pipeline_add)})
                break

    return pairs


def main():
    parser = argparse.ArgumentParser(description="Kuvalam OS - Local LLM Fine-Tuner")
    parser.add_argument('--base', required=True, help="Base model path")
    parser.add_argument('--name', required=True, help="Target model name")
    parser.add_argument('--datasource', default='file', choices=['file', 'database', 'web', 'nosql'], help="Source of training data")
    parser.add_argument('--dataset', required=False, help="Dataset path (PDF, TXT, CSV, JSON, etc)")
    parser.add_argument('--db_url', required=False, help="Database connection string")
    parser.add_argument('--db_query', required=False, help="SQL Query to fetch training data")
    parser.add_argument('--nosql_jsonl', required=False, help="Path to JSONL file with MongoDB schema + samples (generated by JS extractor)")
    parser.add_argument('--web_url', required=False, help="Web URL to crawl for data")
    args = parser.parse_args()

    print(f"Initializing Fine-Tuning Job...")
    print(f"Base Model: {args.base}")
    print(f"Target Name: {args.name}")
    print(f"Data Source: {args.datasource}")
    
    if args.datasource == 'file':
        print(f"Dataset Path: {args.dataset}")
    elif args.datasource == 'database':
        # Mask the DB URL for security in logs
        masked_url = args.db_url.split('@')[-1] if '@' in args.db_url else '***'
        print(f"Database Host: {masked_url}")
        print(f"Database Query: {args.db_query}")
    elif args.datasource == 'nosql':
        print(f"NoSQL JSONL: {args.nosql_jsonl}")
    elif args.datasource == 'web':
        print(f"Web Source: {args.web_url}")

    # =====================================================================
    # PRODUCTION CODE (Requires GPU & Unsloth)
    # =====================================================================
    try:
        import torch
        from unsloth import FastLanguageModel
        from trl import SFTTrainer
        from transformers import TrainingArguments
        from datasets import load_dataset
        
        # Check if we really have Unsloth/GPU ready
        if not torch.cuda.is_available() and not torch.backends.mps.is_available():
            raise ImportError("No GPU detected, falling back to simulation mode.")

        print("Hardware accelerated training environment detected. Starting Unsloth...")
        
        max_seq_length = 2048
        model, tokenizer = FastLanguageModel.from_pretrained(
            model_name = args.base,
            max_seq_length = max_seq_length,
            dtype = None,
            load_in_4bit = True,
        )

        model = FastLanguageModel.get_peft_model(
            model,
            r = 16,
            target_modules = ["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
            lora_alpha = 16,
            lora_dropout = 0,
            bias = "none",
            use_gradient_checkpointing = "unsloth",
        )

        if args.datasource == 'file':
            print(f"Parsing local document: {args.dataset}")
            import mimetypes
            from datasets import Dataset
            import pandas as pd
            
            mime_type, _ = mimetypes.guess_type(args.dataset)
            if str(args.dataset).endswith('.jsonl') or str(args.dataset).endswith('.json'):
                dataset = load_dataset("json", data_files=args.dataset, split="train")
            else:
                # Use langchain unstructured loader for PDFs/TXTs/DOCXs
                from langchain_community.document_loaders import UnstructuredFileLoader
                loader = UnstructuredFileLoader(args.dataset)
                docs = loader.load()
                # Convert loaded docs into simple completion format
                df = pd.DataFrame([{"text": doc.page_content} for doc in docs])
                dataset = Dataset.from_pandas(df)
            print(f"Successfully extracted unstructured text from {args.dataset}")
        elif args.datasource == 'database':
            print("Connecting to database to extract training pairs...")
            import sqlalchemy
            import pandas as pd
            from datasets import Dataset
            
            engine = sqlalchemy.create_engine(args.db_url)
            with engine.connect() as conn:
                df = pd.read_sql(args.db_query, conn)
            dataset = Dataset.from_pandas(df)
            print(f"Successfully loaded {len(dataset)} rows from database.")
        elif args.datasource == 'web':
            print(f"Fetching and parsing data from {args.web_url}...")
            # Placeholder for BeautifulSoup extraction
            import requests
            from datasets import Dataset
            import pandas as pd
            
            resp = requests.get(args.web_url)
            text = resp.text[:10000] # Grab first 10k chars for fast fine-tuning
            
            # Form simple continuation dataset
            df = pd.DataFrame([{"text": text}])
            dataset = Dataset.from_pandas(df)
            print(f"Successfully scraped content from {args.web_url}.")
        elif args.datasource == 'nosql':
            print(f"Loading MongoDB training data from: {args.nosql_jsonl}")
            import json as _json
            import pandas as pd
            from datasets import Dataset
            
            with open(args.nosql_jsonl, 'r') as f:
                mongo_data = _json.load(f)
            collections = mongo_data.get("collections", [])
            print(f"Found {len(collections)} collections: {[c['collection'] for c in collections]}")
            
            mongo_qa = _generate_mongo_qa_pairs(collections)
            mongo_agg = _generate_mongo_aggregation_pairs(collections)
            combined = mongo_qa + mongo_agg
            df = pd.DataFrame(combined) if combined else pd.DataFrame({"text": ["No data found"]})
            dataset = Dataset.from_pandas(df)
            print(f"Loaded {len(dataset)} MongoDB training rows.")

        trainer = SFTTrainer(
            model = model,
            tokenizer = tokenizer,
            train_dataset = dataset,
            dataset_text_field = "text",
            max_seq_length = max_seq_length,
            args = TrainingArguments(
                per_device_train_batch_size = 2,
                gradient_accumulation_steps = 4,
                warmup_steps = 5,
                max_steps = 60,
                learning_rate = 2e-4,
                fp16 = not torch.cuda.is_bf16_supported(),
                bf16 = torch.cuda.is_bf16_supported(),
                logging_steps = 1,
                optim = "adamw_8bit",
                weight_decay = 0.01,
                lr_scheduler_type = "linear",
                seed = 3407,
                output_dir = "outputs",
            ),
        )

        trainer.train()

        print("Training complete. Exporting to GGUF...")
        model.save_pretrained_gguf(args.name, tokenizer, quantization_method = "q4_k_m")
        
        print(f"Export complete! Model {args.name} is ready for Ollama.")
        
        # Auto-import to Ollama
        os.system(f"ollama create {args.name} -f {args.name}/Modelfile")
        sys.exit(0)

    except (ImportError, ModuleNotFoundError) as e:
        # Known missing-dependency paths — route to CPU or fail clearly.
        err_msg = str(e).lower()
        if any(x in err_msg for x in ['gpu', 'unsloth', 'no module', 'cuda', 'not installed',
                                        'no torch', 'no cuda', 'hip', 'rocm', 'cublas']):
            print(f"⚠️  GPU/Unsloth not available ({e}). Trying CPU training path...")
            sys.stdout.flush()
            _run_cpu_training(args)
            # If _run_cpu_training returns, it failed — exit with error
            print("❌ CPU training also failed. Aborting.")
            sys.stdout.flush()
            sys.exit(1)
        # Unknown import error — fail loudly rather than silently simulating.
        print(f"❌ Unexpected import error: {e}")
        import traceback
        traceback.print_exc()
        sys.stdout.flush()
        sys.exit(1)

    except Exception as e:
        # Any other error during GPU training is a real failure.
        # Do NOT silently fall back to simulation — exit with error so the
        # Node.js orchestrator sets status = FAILED.
        print(f"❌ GPU/Unsloth training failed: {e}")
        import traceback
        traceback.print_exc()
        sys.stdout.flush()
        sys.exit(1)

if __name__ == "__main__":
    main()
