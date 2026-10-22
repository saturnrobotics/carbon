-- Kong narrows Supabase Storage to the API Carbon uses (GHSA-8rrf-w776-x75g,
-- GHSA-67rp-h2mf-ph72). Defence in depth: the fix is the patched storage-api.
--
-- storage_api.py renders this into kong.yml as a sandboxed pre-function on every
-- gateway service that forwards to Storage, ahead of the authz_api check when
-- that is on. It judges the path Kong forwards (ngx.var.upstream_uri, relative to
-- Storage's root), percent-decoded until it stops changing, lower-cased, with
-- empty and "." segments dropped and ".." resolved. That is at least as eager as
-- Storage's router, so no spelling of a path reaches a route this check did not
-- recognise.
--
--   /s3...                     403: Storage's S3 protocol. Carbon never uses it.
--   /upload/<x>/sign...        403: signed resumable uploads. Carbon never uses
--                              them; they write with Storage's privileged
--                              database connection (the GHSA-8rrf route).
--   /upload...                 401 without exactly one `Authorization: Bearer
--                              <JWT>`. Carbon's resumable uploads
--                              (apps/erp/app/utils/resumable-upload.ts) always
--                              send the signed-in user's token.
--
-- An OPTIONS request passes unless it carries X-HTTP-Method-Override, which the
-- TUS server would honour: Kong's cors plugin answers browser preflights only
-- after this check runs.
--
-- Kong holds no secret and verifies no signature: Storage verifies the bearer
-- and applies row level security as that role, as it does without this check.
local MESSAGES = {
  s3 = "The S3 protocol is not available",
  signed = "Signed resumable uploads are not available",
  bearer = "Resumable uploads require a bearer token",
}

local function segments()
  local path = (ngx.var.upstream_uri or ""):gsub("[?#].*$", "")
  for _ = 1, 8 do
    local decoded = ngx.unescape_uri(path)
    if decoded == path then
      break
    end
    path = decoded
  end
  local found = {}
  for segment in path:lower():gmatch("[^/\\]+") do
    if segment == ".." then
      found[#found] = nil
    elseif segment ~= "." then
      found[#found + 1] = segment
    end
  end
  return found
end

local function starts(segment, prefix)
  return segment ~= nil and segment:sub(1, #prefix) == prefix
end

local function bearer()
  local value = ngx.req.get_headers(0)["authorization"]
  return type(value) == "string"
    and value:match("^[Bb][Ee][Aa][Rr][Ee][Rr] [%w_-]+%.[%w_-]+%.[%w_-]+$") ~= nil
end

local function deny(status, reason)
  return kong.response.exit(status, { message = MESSAGES[reason] }, { ["Cache-Control"] = "no-store" })
end

return function()
  local path = segments()
  if starts(path[1], "s3") then
    return deny(403, "s3")
  end
  if not starts(path[1], "upload") then
    return
  end
  if starts(path[3], "sign") then
    return deny(403, "signed")
  end
  if kong.request.get_method() == "OPTIONS" and kong.request.get_header("x-http-method-override") == nil then
    return
  end
  if not bearer() then
    return deny(401, "bearer")
  end
end
