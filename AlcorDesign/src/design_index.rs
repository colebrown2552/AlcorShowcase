//! Compact, deterministic views of persisted designs. No browser or network work.
use crate::app::{Page, Project};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

/// First `count` characters of `value`, safe on multi-byte text.
pub fn snippet(value: &str, count: usize) -> String {
    value.chars().take(count).collect()
}
fn strv<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or("")
}
/// `(offset, limit)` from tool arguments, with the limit clamped to `1..=maximum`.
pub fn paging(args: &Value, maximum: usize) -> (usize, usize) {
    (
        args["offset"].as_u64().unwrap_or(0).min(1_000_000) as usize,
        args["limit"]
            .as_u64()
            .unwrap_or(50)
            .clamp(1, maximum as u64) as usize,
    )
}
/// Lower-cased search text from tool arguments.
///
/// # Errors
/// Fails when the query is longer than 2000 bytes.
pub fn query(args: &Value) -> Result<String> {
    let q = args["query"].as_str().unwrap_or("").trim();
    ensure!(q.len() <= 2000, "Search query is too long");
    Ok(q.to_lowercase())
}
/// True for a full 40-character hexadecimal Git commit ID.
pub fn sha_shape(value: &str) -> bool {
    value.len() == 40 && value.bytes().all(|c| c.is_ascii_hexdigit())
}
/// Which commit a page's source should be read at, and why: the page's own capture commit,
/// then the project's pinned commit, then the checkout's HEAD as a labelled fallback.
pub fn provenance(
    project: Option<&Project>,
    page: Option<&Page>,
    workspace_sha: &str,
    repository: Option<&str>,
) -> Value {
    let captured = page.map(|p| p.commit.as_str()).filter(|s| sha_shape(s));
    let pinned = project
        .and_then(|p| p.source["sha"].as_str())
        .filter(|s| sha_shape(s));
    let (sha, basis) = if let Some(s) = captured {
        (s, "page_capture_commit")
    } else if let Some(s) = pinned {
        (s, "project_pinned_commit")
    } else {
        (workspace_sha, "workspace_commit_fallback")
    };
    json!({"repository":repository,"sha":sha,"basis":basis,
        "capture_commit":captured,"project_commit":pinned,"workspace_commit":workspace_sha,
        "source_matches_capture":captured==Some(sha),"page_revision":page.map(|p|p.revision),
        "note":if captured.is_some(){"Repository source is pinned to the capture commit; local design edits are separate."}else{"No capture commit is available; this source association is a repository fallback, not proof of deployed bytes."}})
}
fn searchable(node: &Value) -> String {
    [
        strv(node, "id"),
        strv(node, "name"),
        strv(node, "text"),
        strv(node, "selector"),
        strv(node, "tag"),
        node["attributes"]["id"].as_str().unwrap_or(""),
        node["attributes"]["class"].as_str().unwrap_or(""),
    ]
    .join(" ")
    .to_lowercase()
}
fn route_path(url: &str) -> String {
    url::Url::parse(url)
        .map(|u| u.path().to_string())
        .unwrap_or_else(|_| url.to_string())
}
/// Searchable page index for a project with a URL-derived page tree and paging.
///
/// # Errors
/// Fails when the query is too long.
pub fn index(
    project: &Project,
    args: &Value,
    workspace_sha: &str,
    repository: Option<&str>,
) -> Result<Value> {
    let q = query(args)?;
    let (offset, limit) = paging(args, 100);
    let paths: Vec<_> = project.pages.iter().map(|p| route_path(&p.url)).collect();
    let parents: Vec<_> = paths
        .iter()
        .enumerate()
        .map(|(i, path)| {
            paths
                .iter()
                .enumerate()
                .filter(|(j, parent)| {
                    *j != i
                        && parent.len() < path.len()
                        && (parent.as_str() == "/"
                            || path.starts_with(&format!("{}/", parent.trim_end_matches('/'))))
                })
                .max_by_key(|(_, parent)| parent.len())
                .map(|(j, _)| project.pages[j].id.clone())
        })
        .collect();
    let mut entries = vec![];
    for (i, p) in project.pages.iter().enumerate() {
        let matches: Vec<_> = if q.is_empty() {
            vec![]
        } else {
            p.nodes
                .iter()
                .filter(|n| searchable(n).contains(&q))
                .collect()
        };
        let page_match = format!("{} {} {}", p.id, p.title, p.url)
            .to_lowercase()
            .contains(&q);
        if !q.is_empty() && !page_match && matches.is_empty() {
            continue;
        }
        entries.push(json!({"id":p.id,"page_id":p.id,"title":p.title,"url":p.url,"path":paths[i],
            "parent_page_id":parents[i],"depth":paths[i].split('/').filter(|s|!s.is_empty()).count(),
            "child_count":parents.iter().filter(|x|x.as_deref()==Some(&p.id)).count(),"status":p.status,
            "revision":p.revision,"node_count":p.nodes.len(),"matched_node_count":matches.len(),
            "snippet":matches.first().map(|n|snippet(strv(n,"text"),180)).unwrap_or_default(),
            "node_matches":matches.iter().take(3).map(|n|json!({"id":n["id"],"selector":n["selector"],"tag":n["tag"],"text":snippet(strv(n,"text"),180)})).collect::<Vec<_>>(),
            "provenance":provenance(Some(project),Some(p),workspace_sha,repository),"discovery":p.discovery}));
    }
    entries.sort_by(|a, b| {
        strv(a, "path")
            .cmp(strv(b, "path"))
            .then(strv(a, "id").cmp(strv(b, "id")))
    });
    let total = entries.len();
    let next = if offset.saturating_add(limit) < total {
        Some(offset + limit)
    } else {
        None
    };
    Ok(
        json!({"project_id":project.id,"project_revision":project.revision,"query":q,"total":total,"page_count":project.pages.len(),"offset":offset,"limit":limit,"next_offset":next,
        "entries":entries.into_iter().skip(offset).take(limit).collect::<Vec<_>>(),
        "sitemaps":project.source.get("sitemaps").cloned().unwrap_or(json!([])),"sitemap_sync":project.source["sitemap_sync"],"discovery":project.source["discovery"],
        "id_scope":"Page IDs persist within this design project. Node IDs persist across saved-snapshot edits; a fresh independent import gets new IDs."}),
    )
}

/// Bounded, searchable layer tree for one page, with breadcrumbs and paging.
///
/// # Errors
/// Fails when the query is too long or `node_id` is not in the page.
pub fn page_tree(
    project: &Project,
    page: &Page,
    args: &Value,
    workspace_sha: &str,
    repository: Option<&str>,
) -> Result<Value> {
    let q = query(args)?;
    let (offset, limit) = paging(args, 200);
    let depth = args["depth"].as_u64().unwrap_or(3).min(20) as usize;
    let by_id: BTreeMap<&str, &Value> = page
        .nodes
        .iter()
        .filter_map(|n| n["id"].as_str().map(|id| (id, n)))
        .collect();
    let mut children: BTreeMap<Option<&str>, Vec<&str>> = BTreeMap::new();
    for n in &page.nodes {
        if let Some(id) = n["id"].as_str() {
            let parent = n["parent_id"]
                .as_str()
                .filter(|p| *p != id && by_id.contains_key(p));
            children.entry(parent).or_default().push(id);
        }
    }
    let requested = args["node_id"].as_str().filter(|s| !s.is_empty());
    if let Some(id) = requested {
        ensure!(by_id.contains_key(id), "Node not found in this page");
    }
    let roots = requested
        .map(|id| vec![id])
        .unwrap_or_else(|| children.get(&None).cloned().unwrap_or_default());
    let mut stack: Vec<_> = roots
        .iter()
        .rev()
        .map(|id| (*id, 0usize, Vec::<String>::new()))
        .collect();
    let mut visited = BTreeSet::new();
    let mut found = vec![];
    while let Some((id, level, ancestors)) = stack.pop() {
        if !visited.insert(id) {
            continue;
        }
        let node = by_id[id];
        let descendants = children.get(&Some(id)).cloned().unwrap_or_default();
        if q.is_empty() || searchable(node).contains(&q) {
            found.push(json!({"id":id,"parent_id":node["parent_id"],"selector":node["selector"],"tag":node["tag"],"name":node["name"],
                "text":snippet(strv(node,"text"),240),"text_truncated":strv(node,"text").chars().count()>240,
                "x":node["x"],"y":node["y"],"width":node["width"],"height":node["height"],
                "depth":level,"child_count":descendants.len(),"breadcrumb":ancestors,
                "styles":{ "display":node["styles"]["display"],"color":node["styles"]["color"],"font-size":node["styles"]["font-size"]}}));
        }
        if !q.is_empty() || level < depth {
            let mut trail = ancestors.clone();
            trail.push(id.to_string());
            for child in descendants.iter().rev() {
                stack.push((child, level + 1, trail.clone()));
            }
        }
    }
    let total = found.len();
    let next = if offset.saturating_add(limit) < total {
        Some(offset + limit)
    } else {
        None
    };
    Ok(
        json!({"project_id":project.id,"page_id":page.id,"page_revision":page.revision,"query":q,"roots":roots,"depth":depth,"query_scans_all_depths":!q.is_empty(),
        "offset":offset,"limit":limit,"total":total,"captured_node_count":page.nodes.len(),"next_offset":next,
        "nodes":found.into_iter().skip(offset).take(limit).collect::<Vec<_>>(),"provenance":provenance(Some(project),Some(page),workspace_sha,repository),
        "capture_warnings":page.warnings}),
    )
}

/// Repository path for a site URL path, given the folder that holds the web root.
pub fn web_root_path(source_root: &str, url_path: &str) -> String {
    let path = url_path.trim_start_matches('/');
    if source_root.is_empty() {
        path.to_owned()
    } else {
        format!("{source_root}/{path}")
    }
}

/// Linked stylesheets and inline `<style>` blocks in a page's captured HTML. Same-origin
/// stylesheet URLs are mapped to a candidate repository path under `source_root`.
///
/// # Errors
/// Fails when the page URL cannot be parsed.
pub fn stylesheet_links(page: &Page, source_root: &str) -> Result<(Vec<Value>, Vec<Value>)> {
    let doc = scraper::Html::parse_document(&page.html);
    let base = url::Url::parse(&page.url).context("Page URL cannot resolve stylesheet links")?;
    let selector = scraper::Selector::parse("link[href]").unwrap();
    let mut links = vec![];
    let mut seen = BTreeSet::new();
    for node in doc.select(&selector) {
        if !node
            .value()
            .attr("rel")
            .unwrap_or("")
            .split_ascii_whitespace()
            .any(|r| r.eq_ignore_ascii_case("stylesheet"))
        {
            continue;
        }
        let Ok(url) = base.join(node.value().attr("href").unwrap_or("")) else {
            continue;
        };
        if !matches!(url.scheme(), "http" | "https")
            || !url.username().is_empty()
            || url.password().is_some()
            || !seen.insert(url.as_str().to_string())
        {
            continue;
        }
        // Only the page's own origin maps into the repository; CDN and other hosts are external.
        let repo_path = (url.origin() == base.origin() && url.path().len() > 1)
            .then(|| web_root_path(source_root, url.path()));
        links.push(json!({"url":url.as_str(),"repo_path":repo_path,"media":node.value().attr("media").unwrap_or("all"),"source":"linked-stylesheet"}));
    }
    let selector = scraper::Selector::parse("style").unwrap();
    let mut inline = vec![];
    let mut budget = 120_000usize;
    for (index, node) in doc.select(&selector).enumerate() {
        let text = node.text().collect::<String>();
        let content = snippet(&text, budget.min(30_000));
        budget = budget.saturating_sub(content.len());
        inline.push(json!({"index":index,"id":node.value().attr("id"),"bytes":text.len(),"preview":snippet(&text,200),"content":content,"truncated":content.len()<text.len()}));
        if inline.len() >= 100 {
            break;
        }
    }
    Ok((links, inline))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Project {
        serde_json::from_value(json!({"id":"project","name":"Fixture","source":{"sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"revision":1,"created":1,"job_id":null,"pages":[
            {"id":"home","title":"Home","url":"https://www.example.com/","status":"ready","viewport":{},"screenshot":"","revision":1,"nodes":[]},
            {"id":"about","title":"About","url":"https://www.example.com/about/","status":"ready","viewport":{},"screenshot":"","revision":1,"commit":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","nodes":[
                {"id":"root","parent_id":null,"tag":"main","selector":"[data-alcor-design-id=\"root\"]","name":"Canvas"},
                {"id":"child","parent_id":"root","tag":"section","selector":"[data-alcor-design-id=\"child\"]"},
                {"id":"leaf","parent_id":"child","tag":"h1","text":"Unique field recordings","selector":"[data-alcor-design-id=\"leaf\"]"}]}]})).unwrap()
    }
    #[test]
    fn page_search_and_url_tree() {
        let p = fixture();
        let v = index(
            &p,
            &json!({"query":"recordings","limit":1}),
            "cccccccccccccccccccccccccccccccccccccccc",
            None,
        )
        .unwrap();
        assert_eq!(v["total"], 1);
        assert_eq!(v["entries"][0]["id"], "about");
        assert_eq!(v["entries"][0]["parent_page_id"], "home");
        assert_eq!(v["entries"][0]["matched_node_count"], 1);
        assert_eq!(
            v["entries"][0]["provenance"]["sha"],
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        );
    }
    #[test]
    fn bounded_tree_and_deep_search() {
        let p = fixture();
        let page = &p.pages[1];
        let v = page_tree(&p, page, &json!({"depth":0}), "workspace", None).unwrap();
        assert_eq!(v["total"], 1);
        assert_eq!(v["nodes"][0]["child_count"], 1);
        let v = page_tree(
            &p,
            page,
            &json!({"depth":0,"query":"recordings"}),
            "workspace",
            None,
        )
        .unwrap();
        assert_eq!(v["nodes"][0]["id"], "leaf");
        assert_eq!(v["nodes"][0]["breadcrumb"], json!(["root", "child"]));
        let v = page_tree(
            &p,
            page,
            &json!({"depth":20,"limit":1,"offset":1}),
            "workspace",
            None,
        )
        .unwrap();
        assert_eq!(v["nodes"][0]["id"], "child");
        assert_eq!(v["next_offset"], 2);
    }
    #[test]
    fn stylesheet_provenance_and_inline_bounds() {
        let mut p = fixture();
        p.pages[1].html = format!(
            "<link rel='stylesheet' href='/wp-content/themes/a/main.css?ver=1'><link rel='stylesheet' href='https://cdn.example/a.css'><style id='one'>{}</style>",
            "x".repeat(40000)
        );
        let (links, inline) = stylesheet_links(&p.pages[1], "site").unwrap();
        assert_eq!(links[0]["repo_path"], "site/wp-content/themes/a/main.css");
        assert!(links[1]["repo_path"].is_null());
        let (links, _) = stylesheet_links(&p.pages[1], "").unwrap();
        assert_eq!(links[0]["repo_path"], "wp-content/themes/a/main.css");
        assert_eq!(inline[0]["truncated"], true);
        assert_eq!(inline[0]["content"].as_str().unwrap().len(), 30000);
    }
    #[test]
    fn missing_parent_is_root_and_invalid_node_rejected() {
        let mut p = fixture();
        p.pages[1].nodes[0]["parent_id"] = json!("missing");
        let v = page_tree(&p, &p.pages[1], &json!({}), "workspace", None).unwrap();
        assert_eq!(v["roots"], json!(["root"]));
        assert!(
            page_tree(
                &p,
                &p.pages[1],
                &json!({"node_id":"absent"}),
                "workspace",
                None
            )
            .is_err()
        );
    }
}
