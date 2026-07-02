// create-caller — admin-only Edge Function that creates a caller login.
//
// Why a function: the service_role key can create users but must NEVER ship
// in the browser (it grants full DB access). This runs server-side, verifies
// the request really comes from an admin, then creates the user.
//
// Deploy:
//   supabase functions deploy create-caller
// (SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are injected
//  automatically by the platform — no secrets to set.)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let payload: any;
  try { payload = await req.json(); } catch { return json({ error: "Bad JSON body." }, 400); }

  const adminEmail = String(payload.admin_email || "").trim();
  const adminPass = String(payload.admin_password || "");
  const callerName = String(payload.caller_name || "").trim();
  const callerPass = String(payload.caller_password || "");

  if (!callerName || !callerPass) return json({ error: "Caller name and password required." }, 400);
  if (callerPass.length < 6) return json({ error: "Caller password must be at least 6 characters." }, 400);
  if (!adminEmail || !adminPass) return json({ error: "Admin email and password required." }, 400);

  // 1) verify the requester's admin credentials
  const authClient = createClient(URL, ANON);
  const { data: signin, error: signErr } = await authClient.auth.signInWithPassword({
    email: adminEmail, password: adminPass,
  });
  if (signErr || !signin?.user) return json({ error: "Wrong admin email or password." }, 401);

  const admin = createClient(URL, SERVICE);
  const { data: prof } = await admin.from("profiles").select("role").eq("id", signin.user.id).single();
  if (!prof || prof.role !== "admin") return json({ error: "Not authorized — admin only." }, 403);

  // 2) synthesize a login email from the caller's name
  const slug = callerName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug) return json({ error: "Caller name must contain letters or numbers." }, 400);

  const email = `${slug}@calldesk.local`;

  // 3) create the auth user (pre-confirmed) — the on_auth_user_created trigger makes the profile row
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password: callerPass,
    email_confirm: true,
    user_metadata: { full_name: callerName },
  });
  if (createErr) {
    const dup = /already|registered|exists/i.test(createErr.message);
    return json({ error: dup ? `A caller named "${callerName}" already exists.` : createErr.message }, dup ? 409 : 400);
  }

  // 4) set the display name + role on the profile
  await admin.from("profiles").update({ full_name: callerName, role: "agent" }).eq("id", created.user!.id);

  return json({ ok: true, email, name: callerName });
});
