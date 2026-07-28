const d3 = globalThis.d3;

const roleOrder = [
  "COMPOSITION ROOT",
  "DRIVING PORT",
  "USE CASE",
  "POLICY",
  "DRIVEN PORT",
  "ADAPTER",
];
const roleColors = {
  "COMPOSITION ROOT": "#f7b955",
  "DRIVING PORT": "#a78bfa",
  "USE CASE": "#60a5fa",
  POLICY: "#79c96b",
  "DRIVEN PORT": "#f18ab5",
  ADAPTER: "#ef6a6a",
};

const graphShell = requiredElement("graph-shell");
const svgElement = requiredElement("graph");
const summaryElement = requiredElement("summary");
const viewSelect = requiredElement("view");
const searchInput = requiredElement("search");
const edgeKindSelect = requiredElement("edge-kind");
const externalControl = requiredElement("external-control");
const externalCheckbox = requiredElement("external");
const resetButton = requiredElement("reset");
const hintElement = requiredElement("hint");
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
  const backdropLayer = viewport.append("g");
  const linkLayer = viewport.append("g");
  const nodeLayer = viewport.append("g");
  const zoom = d3
    .zoom()
    .scaleExtent([0.2, 6])
    .on("zoom", (event) => viewport.attr("transform", event.transform));
  svg.call(zoom);
  addArrowMarker(svg);

  const declarationsByPath = d3.group(manifest.controlledDeclarations, (entry) => entry.path);
  const modulesByPath = new Map(manifest.modules.map((module) => [module.path, module]));
  const internalPaths = new Set(modulesByPath.keys());
  const moduleGroups = [
    ...new Set(manifest.modules.map((module) => subsystem(module.path, manifest.sourceRoot))),
  ];
  const moduleColor = d3.scaleOrdinal(moduleGroups, d3.schemeTableau10);

  let simulation;
  let nodeSelection;
  let linkSelection;
  let selectedNode;

  const resetZoom = () => {
    svg.transition().duration(250).call(zoom.transform, d3.zoomIdentity);
  };

  const renderDetails = (node) => {
    if (node?.kind === "role") renderRoleDetails(node, manifest);
    else renderModuleDetails(node, modulesByPath, declarationsByPath);
  };

  const applyEmphasis = () => {
    const query = searchInput.value.trim().toLocaleLowerCase();
    const matches = new Set();
    nodeSelection.each((node) => {
      if (query.length > 0 && node.searchText.includes(query)) matches.add(node.id);
    });
    nodeSelection
      .classed("is-selected", (node) => node.id === selectedNode?.id)
      .classed("is-match", (node) => matches.has(node.id))
      .classed("is-muted", (node) => {
        if (selectedNode !== undefined) {
          return (
            node.id !== selectedNode.id && !nodeIsLinked(node.id, selectedNode.id, linkSelection)
          );
        }
        return query.length > 0 && !matches.has(node.id);
      });
    linkSelection
      .classed("is-active", (link) =>
        selectedNode === undefined ? false : linkTouches(link, selectedNode.id),
      )
      .classed("is-muted", (link) => {
        if (selectedNode !== undefined) return !linkTouches(link, selectedNode.id);
        if (query.length === 0) return false;
        return (
          !matches.has(linkEndpointId(link.source)) && !matches.has(linkEndpointId(link.target))
        );
      });
  };

  const selectNode = (node) => {
    selectedNode = node;
    applyEmphasis();
    renderDetails(node);
  };

  const clearGraph = () => {
    simulation?.stop();
    simulation = undefined;
    backdropLayer.selectAll("*").remove();
    linkLayer.selectAll("*").remove();
    nodeLayer.selectAll("*").remove();
    selectedNode = undefined;
    renderDetails(undefined);
  };

  const renderRoleOverview = () => {
    const { width, height } = graphShell.getBoundingClientRect();
    const graph = buildRoleGraph(manifest, edgeKindSelect.value);
    positionRoleNodes(graph.nodes, width, height);
    renderArchitectureBackdrop(backdropLayer, width, height);

    linkSelection = linkLayer
      .selectAll("g")
      .data(graph.links, (link) => `${link.source.id}:${link.target.id}`)
      .join("g")
      .attr("class", (link) => `role-relation ${link.edgeKind}`)
      .style("--relation-width", (link) => `${1 + Math.sqrt(link.count) * 0.65}px`);
    linkSelection.append("path").attr("d", (link) => roleRelationGeometry(link, graph.links).path);
    linkSelection
      .append("text")
      .attr("x", (link) => roleRelationGeometry(link, graph.links).labelX)
      .attr("y", (link) => roleRelationGeometry(link, graph.links).labelY)
      .text((link) => link.count);

    nodeSelection = nodeLayer
      .selectAll("g")
      .data(graph.nodes, (node) => node.id)
      .join("g")
      .attr("class", "role-node")
      .attr("transform", (node) => `translate(${node.x},${node.y})`)
      .style("--role-color", (node) => roleColors[node.id])
      .on("click", (event, node) => {
        event.stopPropagation();
        selectNode(node);
      });
    nodeSelection
      .append("rect")
      .attr("x", -78)
      .attr("y", -36)
      .attr("width", 156)
      .attr("height", 72)
      .attr("rx", 12);
    nodeSelection
      .append("text")
      .attr("class", "role-name")
      .attr("y", -4)
      .text((node) => node.label);
    nodeSelection
      .append("text")
      .attr("class", "role-count")
      .attr("y", 16)
      .text((node) => `${node.declarations.length} declarations`);
    nodeSelection
      .append("title")
      .text((node) => `${node.label}: ${node.declarations.length} controlled declarations`);

    summaryElement.textContent = `${manifest.controlledDeclarations.length} controlled declarations · ${graph.dependencyCount} role dependencies`;
    hintElement.textContent =
      "Nested boundaries show core, ports, and outer adapters · click a role";
    externalControl.hidden = true;
  };

  const renderModuleImports = () => {
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
        kind: "module",
        searchText: `${module.path} ${roles.join(" ")}`.toLocaleLowerCase(),
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
            kind: "module",
            searchText: edge.resolvedPath.toLocaleLowerCase(),
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
      .attr("fill", (node) => (node.external ? undefined : moduleColor(node.group)));
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

    summaryElement.textContent = `${nodes.length} modules · ${links.length} import edges`;
    hintElement.textContent =
      "Raw source graph · scroll to zoom · drag modules · click for details";
    externalControl.hidden = false;
  };

  const renderGraph = () => {
    clearGraph();
    if (viewSelect.value === "roles") renderRoleOverview();
    else renderModuleImports();
    applyEmphasis();
  };

  svg.on("click", () => selectNode(undefined));
  viewSelect.addEventListener("change", () => {
    searchInput.value = "";
    searchInput.placeholder =
      viewSelect.value === "roles"
        ? "use case, reconcile, sqlite…"
        : "reconcile, commands, sqlite…";
    renderGraph();
    resetZoom();
  });
  searchInput.addEventListener("input", applyEmphasis);
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

function buildRoleGraph(manifest, edgeKind) {
  const declarationsByRole = d3.group(manifest.controlledDeclarations, (entry) => entry.role);
  const nodes = roleOrder.map((role) => {
    const declarations = declarationsByRole.get(role) ?? [];
    return {
      id: role,
      label: role,
      kind: "role",
      declarations,
      searchText: `${role} ${declarations
        .map((entry) => `${entry.declaration} ${entry.path} ${entry.purpose}`)
        .join(" ")}`.toLocaleLowerCase(),
    };
  });
  const nodesByRole = new Map(nodes.map((node) => [node.id, node]));
  const relations = new Map();
  let dependencyCount = 0;

  for (const declaration of manifest.controlledDeclarations) {
    for (const dependency of declaration.dependencies) {
      if (edgeKind !== "all" && dependency.edgeKind !== edgeKind) continue;
      dependencyCount += 1;
      if (declaration.role === dependency.role) continue;
      const key = `${declaration.role}:${dependency.role}`;
      const relation = relations.get(key) ?? {
        source: nodesByRole.get(declaration.role),
        target: nodesByRole.get(dependency.role),
        count: 0,
        edgeKinds: new Set(),
      };
      relation.count += 1;
      relation.edgeKinds.add(dependency.edgeKind);
      relations.set(key, relation);
    }
  }

  const links = [...relations.values()].map((relation) => ({
    ...relation,
    edgeKind: relation.edgeKinds.size === 1 ? [...relation.edgeKinds][0] : "mixed",
  }));
  return { nodes, links, dependencyCount };
}

function positionRoleNodes(nodes, width, height) {
  const horizontal = Math.max(310, Math.min(width * 0.36, 430));
  const vertical = Math.max(190, Math.min(height * 0.32, 270));
  const positions = {
    "COMPOSITION ROOT": [0, -vertical],
    "DRIVING PORT": [-horizontal, 0],
    "USE CASE": [-105, 0],
    POLICY: [105, 0],
    "DRIVEN PORT": [horizontal, 0],
    ADAPTER: [0, vertical],
  };
  for (const node of nodes) [node.x, node.y] = positions[node.id];
}

function renderArchitectureBackdrop(layer, width, height) {
  const horizontal = Math.max(310, Math.min(width * 0.36, 430));
  const vertical = Math.max(190, Math.min(height * 0.32, 270));
  const rings = [
    { className: "architecture-ring", xRadius: horizontal + 115, yRadius: vertical + 80 },
    { className: "architecture-ring ports", xRadius: horizontal + 85, yRadius: 145 },
    { className: "architecture-ring core", xRadius: 205, yRadius: 105 },
  ];
  layer
    .selectAll("polygon")
    .data(rings)
    .join("polygon")
    .attr("class", (ring) => ring.className)
    .attr("points", (ring) => hexagonPoints(ring.xRadius, ring.yRadius));
  layer
    .selectAll("text")
    .data([
      { label: "OUTER BOUNDARY · ADAPTERS & COMPOSITION", y: -vertical - 55 },
      { label: "APPLICATION PORTS", y: -125 },
      { label: "APPLICATION CORE", y: -83 },
    ])
    .join("text")
    .attr("class", "ring-label")
    .attr("x", 0)
    .attr("y", (entry) => entry.y)
    .text((entry) => entry.label);
}

function roleRelationGeometry(link, links) {
  const source = link.source;
  const target = link.target;
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const distance = Math.hypot(dx, dy) || 1;
  const padding = 84;
  const startX = source.x + (dx / distance) * padding;
  const startY = source.y + (dy / distance) * padding;
  const endX = target.x - (dx / distance) * padding;
  const endY = target.y - (dy / distance) * padding;
  const hasReverse = links.some(
    (candidate) => candidate.source.id === target.id && candidate.target.id === source.id,
  );
  let bend = 0;
  if (hasReverse) bend = source.id.localeCompare(target.id) < 0 ? 34 : -34;
  const normalX = -dy / distance;
  const normalY = dx / distance;
  const controlX = (startX + endX) / 2 + normalX * bend;
  const controlY = (startY + endY) / 2 + normalY * bend;
  return {
    path: `M${startX},${startY} Q${controlX},${controlY} ${endX},${endY}`,
    labelX: controlX,
    labelY: controlY - 5,
  };
}

function renderRoleDetails(node, manifest) {
  detailsElement.replaceChildren();
  if (node === undefined) {
    showEmptyDetails();
    return;
  }

  showPopulatedDetails();
  detailsElement.append(
    textElement("h2", node.label),
    textElement("p", "Controlled architecture role", "path"),
  );
  const pills = document.createElement("div");
  pills.className = "pills";
  pills.append(textElement("span", `${node.declarations.length} declarations`, "pill"));
  detailsElement.append(pills);

  const outgoing = new Map();
  const incoming = new Map();
  for (const declaration of manifest.controlledDeclarations) {
    for (const dependency of declaration.dependencies) {
      if (declaration.role === node.id) increment(outgoing, dependency.role);
      if (dependency.role === node.id) increment(incoming, declaration.role);
    }
  }
  appendDetailSection(detailsElement, "Depends on", roleCountRows(outgoing));
  appendDetailSection(detailsElement, "Used by", roleCountRows(incoming));
  appendDetailSection(
    detailsElement,
    `Declarations (${node.declarations.length})`,
    node.declarations.map((entry) => ({
      primary: entry.declaration,
      secondary: `${entry.path} · ${entry.purpose}`,
    })),
  );
}

function renderModuleDetails(node, modulesByPath, declarationsByPath) {
  detailsElement.replaceChildren();
  if (node === undefined) {
    showEmptyDetails();
    return;
  }

  showPopulatedDetails();
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

function showEmptyDetails() {
  detailsElement.hidden = true;
  detailsEmpty.hidden = false;
}

function showPopulatedDetails() {
  detailsElement.hidden = false;
  detailsEmpty.hidden = true;
}

function roleCountRows(counts) {
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([role, count]) => ({ primary: role, secondary: `${count} declaration dependencies` }));
}

function increment(counts, key) {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function nodeIsLinked(nodeId, selectedId, links) {
  return links.data().some((link) => linkTouches(link, selectedId) && linkTouches(link, nodeId));
}

function linkTouches(link, nodeId) {
  return linkEndpointId(link.source) === nodeId || linkEndpointId(link.target) === nodeId;
}

function addArrowMarker(svg) {
  const marker = svg
    .append("defs")
    .append("marker")
    .attr("id", "role-arrow")
    .attr("viewBox", "0 -5 10 10")
    .attr("refX", 9)
    .attr("refY", 0)
    .attr("markerWidth", 5)
    .attr("markerHeight", 5)
    .attr("orient", "auto");
  marker.append("path").attr("d", "M0,-5L10,0L0,5").attr("fill", "#8d9ab0");
}

function hexagonPoints(xRadius, yRadius) {
  return [
    [-xRadius * 0.58, -yRadius],
    [xRadius * 0.58, -yRadius],
    [xRadius, 0],
    [xRadius * 0.58, yRadius],
    [-xRadius * 0.58, yRadius],
    [-xRadius, 0],
  ]
    .map((point) => point.join(","))
    .join(" ");
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
