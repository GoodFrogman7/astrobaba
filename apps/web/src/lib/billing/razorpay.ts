/** Razorpay Checkout, loaded only on the wallet page and only when the provider is Razorpay. */
export const CHECKOUT_SRC = "https://checkout.razorpay.com/v1/checkout.js";

export interface RazorpaySuccess {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
}

export interface RazorpayOptions {
  key: string;
  order_id: string;
  amount: number;
  currency: string;
  name: string;
  description: string;
  handler: (r: RazorpaySuccess) => void;
  modal: { ondismiss: () => void };
}

export interface RazorpayInstance {
  open(): void;
  on(event: "payment.failed", cb: (r: unknown) => void): void;
}

type RazorpayCtor = new (o: RazorpayOptions) => RazorpayInstance;

declare global {
  interface Window {
    Razorpay?: RazorpayCtor;
  }
}

let loading: Promise<RazorpayCtor> | null = null;

export function loadRazorpay(): Promise<RazorpayCtor> {
  if (window.Razorpay) return Promise.resolve(window.Razorpay);
  if (loading) return loading;
  loading = new Promise<RazorpayCtor>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = CHECKOUT_SRC;
    s.async = true;
    s.onload = () => (window.Razorpay ? resolve(window.Razorpay) : reject(new Error("no ctor")));
    s.onerror = () => {
      loading = null;
      s.remove();
      reject(new Error("checkout script failed"));
    };
    document.head.appendChild(s);
  });
  return loading;
}
