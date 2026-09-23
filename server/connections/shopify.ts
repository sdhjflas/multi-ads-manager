import { z } from 'zod';
import type { SourceConnection } from '../../shared/connections.js';
import { ConnectorError } from '../connectors/connector.js';
import { boundedJson, safeFetch } from './http.js';
import type { ProviderObserver, ProviderSyncResult } from './provider.js';

export interface ShopifyCredential {
  accessToken: string;
  shopDomain: string;
}

const shopDomain = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{1,60}\.myshopify\.com$/);
const money = z.string().regex(/^\d+(\.\d{1,6})?$/);
const cents = (value: string) => {
  const [whole, fraction = ''] = value.split('.');
  const padded = `${fraction}00`;
  const rounded = BigInt(whole) * 100n + BigInt(padded.slice(0, 2));
  const third = Number(padded[2] || '0');
  const result = rounded + (third >= 5 ? 1n : 0n);
  if (result > BigInt(Number.MAX_SAFE_INTEGER))
    throw new ConnectorError('invalid', 'Shopify returned a money value outside the safe range.');
  return Number(result);
};

const pageInfo = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() });
const shopResponse = z.object({
  data: z.object({
    shop: z.object({
      id: z.string(),
      name: z.string(),
      currencyCode: z.string(),
      timezoneAbbreviation: z.string().nullable().optional(),
      ianaTimezone: z.string().nullable().optional(),
    }),
  }),
});
const variantsResponse = z.object({
  data: z.object({
    productVariants: z.object({
      pageInfo,
      nodes: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          sku: z.string().nullable(),
          price: money,
          inventoryQuantity: z.number().int().nullable(),
          updatedAt: z.iso.datetime(),
          product: z.object({
            id: z.string(),
            title: z.string(),
            handle: z.string(),
            updatedAt: z.iso.datetime(),
          }),
        }),
      ),
    }),
  }),
});
const ordersResponse = z.object({
  data: z.object({
    orders: z.object({
      pageInfo,
      nodes: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          processedAt: z.iso.datetime(),
          updatedAt: z.iso.datetime(),
          cancelledAt: z.iso.datetime().nullable(),
          test: z.boolean(),
          currencyCode: z.string(),
          displayFinancialStatus: z.string().nullable(),
          currentShippingPriceSet: z.object({
            shopMoney: z.object({ amount: money, currencyCode: z.string() }),
          }),
          lineItems: z.object({
            pageInfo,
            nodes: z.array(
              z.object({
                id: z.string(),
                sku: z.string().nullable(),
                quantity: z.number().int().nonnegative(),
                discountedTotalSet: z.object({
                  shopMoney: z.object({ amount: money, currencyCode: z.string() }),
                }),
              }),
            ),
          }),
          refunds: z.array(
            z.object({
              id: z.string(),
              createdAt: z.iso.datetime(),
              refundLineItems: z.object({
                pageInfo,
                nodes: z.array(
                  z.object({
                    quantity: z.number().int().nonnegative(),
                    subtotalSet: z.object({
                      shopMoney: z.object({ amount: money, currencyCode: z.string() }),
                    }),
                    lineItem: z.object({ id: z.string() }),
                  }),
                ),
              }),
            }),
          ),
        }),
      ),
    }),
  }),
});

const SHOP_QUERY = `query OrbitShop { shop { id name currencyCode timezoneAbbreviation ianaTimezone } }`;
const VARIANT_QUERY = `query OrbitVariants($cursor: String) {
  productVariants(first: 100, after: $cursor, sortKey: UPDATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes { id title sku price inventoryQuantity updatedAt product { id title handle updatedAt } }
  }
}`;
const ORDER_QUERY = `query OrbitOrders($cursor: String, $filter: String!) {
  orders(first: 50, after: $cursor, sortKey: UPDATED_AT, query: $filter) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id name processedAt updatedAt cancelledAt test currencyCode displayFinancialStatus
      currentShippingPriceSet { shopMoney { amount currencyCode } }
      lineItems(first: 100) {
        pageInfo { hasNextPage endCursor }
        nodes { id sku quantity discountedTotalSet { shopMoney { amount currencyCode } } }
      }
      refunds {
        id createdAt
        refundLineItems(first: 100) {
          pageInfo { hasNextPage endCursor }
          nodes { quantity subtotalSet { shopMoney { amount currencyCode } } lineItem { id } }
        }
      }
    }
  }
}`;

export class ShopifyObserver implements ProviderObserver {
  constructor(
    private credential: ShopifyCredential,
    private fetcher: typeof fetch = fetch,
    private apiVersion = process.env.SHOPIFY_API_VERSION || '2026-07',
  ) {
    this.credential.shopDomain = shopDomain.parse(this.credential.shopDomain);
    if (!/^\d{4}-\d{2}$/.test(this.apiVersion))
      throw new ConnectorError('invalid', 'SHOPIFY_API_VERSION must use YYYY-MM.');
  }

  private async query<T>(schema: z.ZodType<T>, query: string, variables: object): Promise<T> {
    const url = new URL(
      `https://${this.credential.shopDomain}/admin/api/${this.apiVersion}/graphql.json`,
    );
    const response = await safeFetch(
      this.fetcher,
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': this.credential.accessToken,
        },
        body: JSON.stringify({ query, variables }),
      },
      'Shopify',
      (host) => host === this.credential.shopDomain,
    );
    const raw = await boundedJson(response, 'Shopify');
    if (raw && typeof raw === 'object' && 'errors' in raw)
      throw new ConnectorError('invalid', 'Shopify GraphQL returned query errors.');
    const parsed = schema.safeParse(raw);
    if (!parsed.success)
      throw new ConnectorError('invalid', 'Shopify returned an unexpected response contract.');
    return parsed.data;
  }

  async collect(_connection: SourceConnection, since: string | null): Promise<ProviderSyncResult> {
    const shop = (await this.query(shopResponse, SHOP_QUERY, {})).data.shop;
    const variants: z.infer<typeof variantsResponse>['data']['productVariants']['nodes'] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 200; page++) {
      const result: z.infer<typeof variantsResponse>['data']['productVariants'] = (
        await this.query(variantsResponse, VARIANT_QUERY, { cursor })
      ).data.productVariants;
      variants.push(...result.nodes);
      if (!result.pageInfo.hasNextPage) break;
      if (!result.pageInfo.endCursor || result.pageInfo.endCursor === cursor)
        throw new ConnectorError('invalid', 'Shopify repeated a product pagination cursor.');
      cursor = result.pageInfo.endCursor;
      if (page === 199) throw new ConnectorError('invalid', 'Shopify product pagination exceeded the safety limit.');
    }
    const from = since
      ? new Date(Math.max(0, Date.parse(since) - 7 * 86_400_000)).toISOString()
      : new Date(Date.now() - 60 * 86_400_000).toISOString();
    const orders: z.infer<typeof ordersResponse>['data']['orders']['nodes'] = [];
    cursor = null;
    for (let page = 0; page < 200; page++) {
      const result: z.infer<typeof ordersResponse>['data']['orders'] = (
        await this.query(ordersResponse, ORDER_QUERY, {
          cursor,
          filter: `updated_at:>=${from} test:false`,
        })
      ).data.orders;
      for (const order of result.nodes) {
        if (order.lineItems.pageInfo.hasNextPage ||
            order.refunds.some(
              (refund: z.infer<typeof ordersResponse>['data']['orders']['nodes'][number]['refunds'][number]) =>
                refund.refundLineItems.pageInfo.hasNextPage,
            ))
          throw new ConnectorError(
            'invalid',
            `Shopify order ${order.name} exceeds the 100-line safety contract.`,
          );
        orders.push(order);
      }
      if (!result.pageInfo.hasNextPage) break;
      if (!result.pageInfo.endCursor || result.pageInfo.endCursor === cursor)
        throw new ConnectorError('invalid', 'Shopify repeated an order pagination cursor.');
      cursor = result.pageInfo.endCursor;
      if (page === 199) throw new ConnectorError('invalid', 'Shopify order pagination exceeded the safety limit.');
    }
    if (shop.currencyCode !== 'USD')
      throw new ConnectorError('invalid', `Shopify store currency ${shop.currencyCode} is unsupported; Orbit currently requires USD.`);
    const variantObjects = variants.map((variant) => ({
      kind: 'variant',
      externalId: variant.id,
      observedAt: variant.updatedAt,
      value: {
        id: variant.id,
        productId: variant.product.id,
        productTitle: variant.product.title,
        productHandle: variant.product.handle,
        variantTitle: variant.title,
        sku: variant.sku?.trim() || null,
        priceCents: cents(variant.price),
        inventoryQuantity: variant.inventoryQuantity,
        updatedAt: variant.updatedAt,
      },
    }));
    const lineObjects = [];
    let refundCount = 0;
    const paidStatuses = new Set(['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED']);
    for (const order of orders) {
      if (
        order.test ||
        (!order.cancelledAt &&
          (!order.displayFinancialStatus || !paidStatuses.has(order.displayFinancialStatus)))
      )
        continue;
      if (order.currentShippingPriceSet.shopMoney.currencyCode !== 'USD')
        throw new ConnectorError('invalid', 'Shopify returned mixed-currency shipping data.');
      const refunded = new Map<string, number>();
      for (const refund of order.refunds) {
        refundCount++;
        for (const line of refund.refundLineItems.nodes) {
          if (line.subtotalSet.shopMoney.currencyCode !== 'USD')
            throw new ConnectorError('invalid', 'Shopify returned mixed-currency refund data.');
          refunded.set(
            line.lineItem.id,
            (refunded.get(line.lineItem.id) || 0) + cents(line.subtotalSet.shopMoney.amount),
          );
        }
      }
      const paidLines = order.lineItems.nodes.filter((line) => line.quantity > 0);
      const grossByLine = paidLines.map((line) =>
        cents(line.discountedTotalSet.shopMoney.amount),
      );
      const grossTotal = grossByLine.reduce((sum, value) => sum + value, 0);
      const shippingTotal = cents(order.currentShippingPriceSet.shopMoney.amount);
      let shippingAssigned = 0;
      for (const [index, line] of paidLines.entries()) {
        if (line.discountedTotalSet.shopMoney.currencyCode !== 'USD')
          throw new ConnectorError('invalid', 'Shopify returned mixed-currency order data.');
        const gross = grossByLine[index];
        const shippingCents =
          index === paidLines.length - 1
            ? shippingTotal - shippingAssigned
            : grossTotal > 0
              ? Math.floor((shippingTotal * gross) / grossTotal)
              : 0;
        shippingAssigned += shippingCents;
        const refundsCents = refunded.get(line.id) || 0;
        lineObjects.push({
          kind: 'order-line',
          externalId: `${order.id}:${line.id}`,
          observedAt: order.updatedAt,
          value: {
            orderRef: order.id,
            lineRef: line.id,
            orderName: order.name,
            date: order.processedAt.slice(0, 10),
            sku: line.sku?.trim() || null,
            units: order.cancelledAt ? 0 : line.quantity,
            netReceiptsCents: order.cancelledAt
              ? 0
              : Math.max(0, gross + shippingCents - refundsCents),
            refundsCents,
            chargebacksCents: 0,
            chargebacksObserved: false,
            shippingReceiptsCents: shippingCents,
            observedAt: order.updatedAt,
            financialStatus: order.displayFinancialStatus,
            cancelledAt: order.cancelledAt,
          },
        });
      }
    }
    const sourceAsOf = [...variants.map((v) => v.updatedAt), ...orders.map((o) => o.updatedAt)]
      .sort()
      .at(-1) || new Date().toISOString();
    return {
      identity: {
        externalAccountId: shop.id,
        externalAccountName: shop.name,
        currency: shop.currencyCode,
        timezone: shop.ianaTimezone || shop.timezoneAbbreviation || 'UTC',
        region: null,
      },
      objects: { variant: variantObjects, 'order-line': lineObjects },
      counts: {
        accounts: 1,
        products: new Set(variants.map((v) => v.product.id)).size,
        variants: variants.length,
        orders: orders.filter(
          (order) =>
            !order.test &&
            Boolean(
              order.cancelledAt ||
                (order.displayFinancialStatus && paidStatuses.has(order.displayFinancialStatus)),
            ),
        ).length,
        refunds: refundCount,
        unmapped: variants.filter((variant) => !variant.sku?.trim()).length,
      },
      watermark: sourceAsOf,
      sourceAsOf,
      warnings: variants.some((variant) => !variant.sku?.trim())
        ? ['Variants without SKUs were retained as source facts but cannot map to profitability records.']
        : [],
    };
  }
}
