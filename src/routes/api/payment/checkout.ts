import { createFileRoute } from '@tanstack/react-router';

import { getAuth } from '@/core/auth';
import { getPricingProduct } from '@/config/pricing';
import { getAllConfigs } from '@/modules/config/service';
import { createCheckout } from '@/modules/payment/service';
import { hasPermission } from '@/modules/rbac/service';
import { enforceMinIntervalRateLimit } from '@/lib/rate-limit';
import { respData, respErr } from '@/lib/resp';

function safeSameOriginPath(
  input: string | undefined | null,
  fallbackPath: string,
  baseUrl: string
): string {
  if (!input) return fallbackPath;
  try {
    const appUrl = new URL(baseUrl);
    const candidate = new URL(input, appUrl);
    if (candidate.origin !== appUrl.origin) return fallbackPath;
    return candidate.pathname + candidate.search + candidate.hash;
  } catch {
    return fallbackPath;
  }
}

const CNY_ONLY_PROVIDERS = new Set(['alipay', 'wechat']);

async function POST({ request }: { request: Request }) {
  const limited = enforceMinIntervalRateLimit(request, {
    intervalMs: 1000,
    keyPrefix: 'checkout',
  });
  if (limited) return limited;

  try {
    const auth = getAuth();
    const session = await auth.api.getSession({ headers: request.headers });

    if (!session?.user) {
      return respErr('Unauthorized');
    }

    // Per account too: one user can't sidestep the IP bucket by switching networks.
    const userLimited = enforceMinIntervalRateLimit(request, {
      intervalMs: 1000,
      keyPrefix: 'checkout',
      extraKey: session.user.id,
    });
    if (userLimited) return userLimited;

    const body = await request.json().catch(() => ({}));
    const { product_id, payment_provider, redirect } = body;

    if (!product_id || typeof product_id !== 'string') {
      return respErr('Missing product_id');
    }

    // Look up product in the authoritative server-side catalog.
    // We DO NOT trust price / credits / plan from the request body.
    const product = getPricingProduct(product_id);
    if (!product) {
      return respErr('Unknown product');
    }

    // Optional per-provider "test amount" override (admin-configured).
    // Only the charged amount is overridden — credits granted and order
    // amount stored both come from the authoritative catalog. It applies to
    // admins only: the buyer picks the provider, so a test amount left in
    // place would otherwise sell every product for a cent.
    const configs = await getAllConfigs();
    const providerKey = payment_provider || configs.default_payment_provider;
    const testAmountRaw = providerKey
      ? configs[`${providerKey}_test_amount`]
      : undefined;
    const testAmount =
      testAmountRaw && (await hasPermission(session.user.id, 'admin.access'))
        ? parseInt(testAmountRaw)
        : 0;

    // Alipay and WeChat Pay charge CNY only: use the product's CNY price, never
    // its USD number reinterpreted as yuan.
    let basePrice = product.priceInCents;
    let currency = product.currency;
    if (
      CNY_ONLY_PROVIDERS.has(providerKey) &&
      currency.toLowerCase() !== 'cny'
    ) {
      if (!product.cnyPriceInCents || product.cnyPriceInCents <= 0) {
        return respErr(`This product is not available via ${providerKey}`);
      }
      basePrice = product.cnyPriceInCents;
      currency = 'cny';
    }
    const chargeAmount = testAmount > 0 ? testAmount : basePrice;

    // Build success/cancel URLs — only accept same-origin redirects.
    const baseUrl = configs.app_url || 'http://localhost:3000';
    const safeRedirectPath = safeSameOriginPath(
      redirect,
      '/settings/payments',
      baseUrl
    );
    // Straight to the destination: safeSameOriginPath has already reduced it
    // to a path on this site. The old detour through /auth-callback exists to
    // hand a session token to a desktop client — a browser coming back from
    // checkout is already signed in, and that page isn't part of this app.
    const finalRedirect = `${baseUrl}${safeRedirectPath}`;
    const successUrl = `${baseUrl}/api/payment/callback?redirect=${encodeURIComponent(finalRedirect)}`;
    const cancelUrl = `${baseUrl}/pricing`;

    const checkout = await createCheckout({
      userId: session.user.id,
      userEmail: session.user.email,
      productName: product.productName,
      planName: product.planName,
      credits: product.credits,
      creditsValidDays: product.creditsValidDays,
      paymentOrder: {
        productId: product.productId,
        price: { amount: chargeAmount, currency },
        type: product.type,
        description: product.description,
        successUrl,
        cancelUrl,
        customer: {
          email: session.user.email,
          name: session.user.name,
        },
        plan: product.plan
          ? {
              name: product.plan.name,
              interval: product.plan.interval,
              intervalCount: product.plan.intervalCount,
            }
          : undefined,
      },
      provider: payment_provider,
    });

    return respData({ checkout_url: checkout.checkoutInfo.checkoutUrl });
  } catch (error: any) {
    console.error('checkout error:', error);
    return respErr(error.message || 'Checkout failed');
  }
}

export const Route = createFileRoute('/api/payment/checkout')({
  server: {
    handlers: { POST },
  },
});
