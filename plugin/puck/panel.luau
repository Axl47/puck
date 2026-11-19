--!nonstrict
-- Threads panel: who needs you first, then failing PRs, running threads, and
-- finished threads waiting for review. Opened by clicking the bar widget.

local status = noctalia.state.get("status")

local function row(item)
  local children = {
    ui.label({ text = item.title, color = "on_surface", flexGrow = 1 }),
  }
  if item.project ~= "" then
    table.insert(children, ui.label({ text = item.project, color = "on_surface_variant" }))
  end
  return ui.row({ gap = 8, align = "center" }, children)
end

local function section(title, glyph, color, list)
  if type(list) ~= "table" or #list == 0 then return nil end
  local rows = {
    ui.row({ gap = 6, align = "center" }, {
      ui.glyph({ name = glyph, size = 14, color = color }),
      ui.label({ text = `{title} · {#list}`, fontWeight = "medium", color = color }),
    }),
  }
  for _, item in ipairs(list) do
    table.insert(rows, row(item))
  end
  return ui.column({ gap = 6, align = "stretch" }, rows)
end

local function render()
  local body = {}
  if type(status) ~= "table" then
    table.insert(body, ui.label({ text = "Loading…", color = "on_surface_variant" }))
  elseif not status.ok then
    table.insert(body, ui.label({ text = status.error, color = "error" }))
  else
    -- Empty sections are nil, so insert one by one (ipairs would stop at the first nil).
    local function add(s)
      if s then table.insert(body, s) end
    end
    add(section("Needs you", "hand-stop", "primary", status.waiting))
    add(section("Checks failing", "git-pull-request", "error", status.failing))
    add(section("Running", "loader-2", "on_surface", status.running))
    add(section("To review", "inbox", "on_surface_variant", status.review))
    if #body == 0 then
      table.insert(body, ui.label({ text = "No agents running", color = "on_surface_variant" }))
    end
  end

  panel.render(ui.column({ flexGrow = 1, gap = 12, align = "stretch" }, {
    ui.row({ align = "center", justify = "space_between" }, {
      ui.label({ text = "Agents", fontSize = 16, fontWeight = "bold", color = "on_surface" }),
      ui.button({ glyph = "x", variant = "ghost", onClick = function() panel.close() end }),
    }),
    ui.scroll({ flexGrow = 1, gap = 16, align = "stretch" }, body),
  }))
end

noctalia.state.watch("status", function(value)
  status = value
  render()
end)

render()
