--!nonstrict
-- Bar widget: one glyph + count per non-empty state, then today's spend.
--   threads waiting on you · running threads · finished, unreviewed threads ·
--   open PRs (red when checks fail) · $ today
-- Click opens the threads panel.

local status = noctalia.state.get("status")
local spend = noctalia.state.get("spend")

local function count(list)
  return type(list) == "table" and #list or 0
end

local function plural(n, one, many)
  return `{n} {n == 1 and one or many}`
end

local function segment(glyph, n, color)
  return ui.row({ gap = 3, align = "center" }, {
    ui.glyph({ name = glyph, size = 13, color = color }),
    ui.label({ text = tostring(n), color = color }),
  })
end

local function render()
  local items = {}
  local tips = {}
  if type(status) ~= "table" then
    table.insert(items, ui.glyph({ name = "robot", size = 14, color = "on_surface_variant" }))
  elseif not status.ok then
    table.insert(items, ui.glyph({ name = "robot-off", size = 14, color = "error" }))
    table.insert(tips, status.error)
  else
    local running, waiting, review = count(status.running), count(status.waiting), count(status.review)
    if waiting > 0 then
      table.insert(items, segment("hand-stop", waiting, "primary"))
      table.insert(tips, plural(waiting, "thread needs you", "threads need you"))
    end
    if running > 0 then
      table.insert(items, segment("loader-2", running, "on_surface"))
      table.insert(tips, plural(running, "thread running", "threads running"))
    end
    if review > 0 then
      table.insert(items, segment("inbox", review, "on_surface_variant"))
      table.insert(tips, plural(review, "thread to review", "threads to review"))
    end
    local prs = status.prs
    if type(prs) == "table" and prs.open > 0 then
      local color = prs.failing > 0 and "error" or (prs.pending > 0 and "on_surface_variant" or "on_surface")
      table.insert(items, segment("git-pull-request", prs.failing > 0 and prs.failing or prs.open, color))
      if prs.failing > 0 then
        table.insert(tips, `PR checks failing on {prs.failing} of {plural(prs.open, "PR", "PRs")}`)
      elseif prs.pending > 0 then
        table.insert(tips, `PR checks running on {prs.pending} of {plural(prs.open, "PR", "PRs")}`)
      else
        table.insert(tips, plural(prs.open, "open PR", "open PRs"))
      end
    end
  end
  if type(spend) == "number" and spend >= 0.5 then
    table.insert(items, ui.label({ text = string.format("$%.0f", spend), color = "on_surface_variant" }))
    table.insert(tips, string.format("$%.2f today", spend))
  end
  if #items == 0 then
    table.insert(items, ui.glyph({ name = "robot", size = 14, color = "on_surface_variant" }))
  end

  local container = barWidget.isVertical() and ui.column or ui.row
  barWidget.render(container({ gap = 8, align = "center" }, items))
  barWidget.setTooltip(#tips > 0 and table.concat(tips, "\n") or "No agents running")
end

noctalia.state.watch("status", function(value)
  status = value
  render()
end)

noctalia.state.watch("spend", function(value)
  spend = value
  render()
end)

function update()
  noctalia.setUpdateInterval(60000)
  render()
end

function onClick()
  noctalia.togglePanel("axl47/puck:threads")
end
