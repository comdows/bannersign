import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";

export default async function Home() {
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  redirect(user ? "/dashboard" : "/login");
}
