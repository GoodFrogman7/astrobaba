"use client";

import { useEffect, useState } from "react";
import { loadWallet, onWallet } from "@/lib/billing/client";
import type { WalletResponse } from "@/lib/billing/types";

/** undefined while loading, null on error, else signed-in state and wallet. Client-only. */
export function useWallet(): WalletResponse | null | undefined {
  const [w, setW] = useState<WalletResponse | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    const off = onWallet((v) => live && setW(v));
    void loadWallet().then((v) => live && setW(v));
    return () => {
      live = false;
      off();
    };
  }, []);
  return w;
}
