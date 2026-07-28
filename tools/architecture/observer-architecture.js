const d3 = globalThis.d3;

const graphShell = requiredElement("graph-shell");
const svgElement = requiredElement("graph");
const summaryElement = requiredElement("summary");
const searchInput = requiredElement("search");
const edgeKindSelect = requiredElement("edge-kind");
const externalCheckbox = requiredElement("external");
const resetButton = requiredElement("reset");
const detailsEmpty = requiredElement("details-empty");
const detailsElement = requiredElement("details");
const graphError = requiredElement("graph-error");

async function main() {
  if (d3 === undefined) throw new Error("D3 did not load.");
  const response = await fetch("/manifest.json");
  if (!response.ok) throw new Error(`Manifest request failed with status ${response.status}.`);
  const manifest = await response.json();
  createVisualization(manifest);
}

function createVisualization(manifest) {
  const svg = d3.select(svgElement);
  const viewport = svg.append("g");
  const linkLayer = viewport.append("g");
  const nodeLayer = viewport.append("g");
  const zoom = d3
    .zoom()
    .scaleExtent([0.15, 6])
    .on("zoom", (event) => viewport.attr("transform", event.transform));
  svg.call(zoom);

  const declarationsByPath = d3.group(manifest.controlledDeclarations, (entry) => entry.path);
  const modulesByPath = new Map(manifest.modules.map((module) => [module.path, module]));
  const internalPaths = new Set(modulesByPath.keys());
  const groups = [
    ...new Set(manifest.modules.map((module) => subsystem(module.path, manifest.sourceRoot))),
  ];
  const color = d3.scaleOrdinal(groups, d3.schemeTableau10);

  let simulation;
  let nodeSelection;
  let linkSelection;
  let selectedId;

  const resetZoom = () => {
    svg.transition().duration(250).call(zoom.transform, d3.zoomIdentity);
  };

  const selectNode = (node) => {
    selectedId = node?.id;
    nodeSelection?.classed("is-selected", (candidate) => candidate.id === selectedId);
    renderDetails(node, modulesByPath, declarationsByPath);
  };

  const applySearch = () => {
    const query = searchInput.value.trim().toLocaleLowerCase();
    const matches = new Set();
    nodeSelection.each((node) => {
      const searchable = `${node.id} ${node.roles.join(" ")}`.toLocaleLowerCase();
      if (query.length > 0 && searchable.includes(query)) matches.add(node.id);
    });
    nodeSelection
      .classed("is-match", (node) => matches.has(node.id))
      .classed("is-muted", (node) => query.length > 0 && !matches.has(node.id));
    linkSelection.classed("is-muted", (link) => {
      if (query.length === 0) return false;
      return !matches.has(linkEndpointId(link.source)) && !matches.has(linkEndpointId(link.target));
    });
  };

  const renderGraph = () => {
    simulation?.stop();
    linkLayer.selectAll("*").remove();
    nodeLayer.selectAll("*").remove();

    const edgeKind = edgeKindSelect.value;
    const includeExternal = externalCheckbox.checked;
    const nodes = manifest.modules.map((module) => {
      const roles = [
        ...new Set((declarationsByPath.get(module.path) ?? []).map((entry) => entry.role)),
      ].sort();
      return {
        id: module.path,
        label: shortModuleName(module.path),
        group: subsystem(module.path, manifest.sourceRoot),
        roles,
        external: false,
      };
    });
    const nodesByPath = new Map(nodes.map((node) => [node.id, node]));
    const links = [];

    for (const module of manifest.modules) {
      for (const edge of module.imports) {
        if (edgeKind !== "all" && edge.edgeKind !== edgeKind) continue;
        if (!internalPaths.has(edge.resolvedPath) && !includeExternal) continue;
        if (!nodesByPath.has(edge.resolvedPath)) {
          const externalNode = {
            id: edge.resolvedPath,
            label: shortModuleName(edge.resolvedPath),
            group: externalSubsystem(edge.resolvedPath),
            roles: [],
            external: true,
          };
          nodes.push(externalNode);
          nodesByPath.set(externalNode.id, externalNode);
        }
        links.push({
          source: module.path,
          target: edge.resolvedPath,
          edgeKind: edge.edgeKind,
          bindings: edge.bindings,
        });
      }
    }

    linkSelection = linkLayer
      .selectAll("line")
      .data(links)
      .join("line")
      .attr("class", (link) => `link ${link.edgeKind}`);

    nodeSelection = nodeLayer
      .selectAll("g")
      .data(nodes, (node) => node.id)
      .join("g")
      .attr("class", (node) => `node${node.external ? " external" : ""}`)
      .on("click", (event, node) => {
        event.stopPropagation();
        selectNode(node);
      });
    nodeSelection
      .append("circle")
      .attr("r", (node) => (node.external ? 4 : 6))
      .attr("fill", (node) => (node.external ? undefined : color(node.group)));
    nodeSelection
      .append("text")
      .attr("x", 9)
      .attr("y", 3)
      .text((node) => node.label);
    nodeSelection.append("title").text((node) => node.id);

    simulation = d3
      .forceSimulation(nodes)
      .force(
        "link",
        d3
          .forceLink(links)
          .id((node) => node.id)
          .distance((link) => (link.target.external ? 70 : 42))
          .strength(0.16),
      )
      .force("charge", d3.forceManyBody().strength(-105))
      .force(
        "collide",
        d3.forceCollide().radius((node) => (node.external ? 7 : 9)),
      )
      .force("x", d3.forceX().strength(0.025))
      .force("y", d3.forceY().strength(0.025))
      .on("tick", () => {
        linkSelection
          .attr("x1", (link) => link.source.x)
          .attr("y1", (link) => link.source.y)
          .attr("x2", (link) => link.target.x)
          .attr("y2", (link) => link.target.y);
        nodeSelection.attr("transform", (node) => `translate(${node.x},${node.y})`);
      });

    nodeSelection.call(
      d3
        .drag()
        .on("start", (event, node) => {
          if (!event.active) simulation.alphaTarget(0.25).restart();
          node.fx = node.x;
          node.fy = node.y;
        })
        .on("drag", (event, node) => {
          node.fx = event.x;
          node.fy = event.y;
        })
        .on("end", (event, node) => {
          if (!event.active) simulation.alphaTarget(0);
          node.fx = null;
          node.fy = null;
        }),
    );

    summaryElement.textContent = `${nodes.length} nodes · ${links.length} edges · ${manifest.controlledDeclarations.length} controlled declarations`;
    if (selectedId !== undefined) selectNode(nodesByPath.get(selectedId));
    applySearch();
  };

  svg.on("click", () => selectNode(undefined));
  searchInput.addEventListener("input", applySearch);
  edgeKindSelect.addEventListener("change", renderGraph);
  externalCheckbox.addEventListener("change", renderGraph);
  resetButton.addEventListener("click", resetZoom);

  const resize = () => {
    const { width, height } = graphShell.getBoundingClientRect();
    svg.attr("viewBox", `${-width / 2} ${-height / 2} ${width} ${height}`);
    simulation?.force("center", d3.forceCenter(0, 0));
    simulation?.alpha(0.2).restart();
  };
  new ResizeObserver(resize).observe(graphShell);

  renderGraph();
  resize();
}

function renderDetails(node, modulesByPath, declarationsByPath) {
  detailsElement.replaceChildren();
  if (node === undefined) {
    detailsElement.hidden = true;
    detailsEmpty.hidden = false;
    return;
  }

  detailsElement.hidden = false;
  detailsEmpty.hidden = true;
  detailsElement.append(textElement("h2", node.label), textElement("p", node.id, "path"));

  const pills = document.createElement("div");
  pills.className = "pills";
  pills.append(textElement("span", node.external ? "external target" : node.group, "pill"));
  for (const role of node.roles) pills.append(textElement("span", role, "pill"));
  detailsElement.append(pills);

  if (node.external) return;
  const module = modulesByPath.get(node.id);
  const declarations = declarationsByPath.get(node.id) ?? [];
  appendDetailSection(
    detailsElement,
    `Exports (${module.exports.length})`,
    module.exports.map((entry) => ({
      primary: entry.name,
      secondary: `${entry.kind}${entry.role === null ? "" : ` · ${entry.role}`}`,
    })),
  );
  appendDetailSection(
    detailsElement,
    `Controlled declarations (${declarations.length})`,
    declarations.map((entry) => ({
      primary: entry.declaration,
      secondary: `${entry.role} · ${entry.purpose}`,
    })),
  );
  appendDetailSection(
    detailsElement,
    `Imports (${module.imports.length})`,
    module.imports.map((edge) => ({
      primary: edge.resolvedPath,
      secondary: `${edge.edgeKind}${edge.bindings.length === 0 ? "" : ` · ${edge.bindings.join(", ")}`}`,
    })),
  );
}

function appendDetailSection(parent, title, rows) {
  const section = document.createElement("section");
  section.className = "detail-section";
  section.append(textElement("h3", title));
  const list = document.createElement("ul");
  list.className = "detail-list";
  for (const row of rows) {
    const item = document.createElement("li");
    item.append(document.createTextNode(row.primary));
    if (row.secondary.length > 0) item.append(textElement("small", row.secondary));
    list.append(item);
  }
  if (rows.length === 0) list.append(textElement("li", "None"));
  section.append(list);
  parent.append(section);
}

function requiredElement(id) {
  const element = document.querySelector(`#${id}`);
  if (element === null) throw new Error(`Missing element #${id}.`);
  return element;
}

function textElement(tagName, text, className) {
  const element = document.createElement(tagName);
  element.textContent = text;
  if (className !== undefined) element.className = className;
  return element;
}

function subsystem(path, sourceRoot) {
  return path.slice(sourceRoot.length + 1).split("/")[0] || "root";
}

function externalSubsystem(path) {
  return path.split("/").slice(0, 2).join("/");
}

function shortModuleName(path) {
  const parts = path.split("/");
  return (parts.at(-1) ?? path).replace(/\.[^.]+$/, "");
}

function linkEndpointId(endpoint) {
  return typeof endpoint === "string" ? endpoint : endpoint.id;
}

void main().catch((error) => {
  graphError.hidden = false;
  graphError.textContent = error instanceof Error ? error.message : String(error);
  summaryElement.textContent = "Unable to load graph";
});
