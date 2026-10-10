import { createClient } from '@supabase/supabase-js';
import { installSessionGuard } from "./session-guard";

const supabaseUrl = import.meta.env.PUBLIC_SUPABASE_URL;
const supabasePublishableKey = import.meta.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY;

export const supabase = createClient(
  supabaseUrl,
  supabasePublishableKey
);

if (typeof window !== "undefined") {
  installSessionGuard(supabase);
}