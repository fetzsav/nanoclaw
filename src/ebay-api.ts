/**
 * eBay API Client for NanoClaw
 * Handles OAuth2 token management and provides methods for Browse, Inventory,
 * Fulfillment, Account, and Taxonomy APIs.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

const EBAY_AUTH_FILE = path.join(DATA_DIR, 'ebay-auth.json');

// eBay API base URLs (production)
const EBAY_API_BASE = 'https://api.ebay.com';
const EBAY_AUTH_URL = 'https://api.ebay.com/identity/v1/oauth2/token';
const EBAY_API_TIMEOUT_MS = parseInt(process.env.EBAY_API_TIMEOUT_MS || '20000', 10);

interface EbayAuthConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accessToken: string | null;
  accessTokenExpiry: string | null;
  applicationToken: string | null;
  applicationTokenExpiry: string | null;
}

export class EbayApi {
  private config: EbayAuthConfig;

  constructor() {
    if (!fs.existsSync(EBAY_AUTH_FILE)) {
      throw new Error('eBay auth not configured. Create data/ebay-auth.json with clientId, clientSecret, and refreshToken.');
    }
    this.config = JSON.parse(fs.readFileSync(EBAY_AUTH_FILE, 'utf-8'));
    if (!this.config.clientId || !this.config.clientSecret || !this.config.refreshToken) {
      throw new Error('eBay auth config missing required fields: clientId, clientSecret, refreshToken');
    }
  }

  private saveConfig(): void {
    const tempPath = `${EBAY_AUTH_FILE}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(this.config, null, 2));
    fs.renameSync(tempPath, EBAY_AUTH_FILE);
  }

  private getBasicAuth(): string {
    return Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64');
  }

  private async fetchWithTimeout(
    url: string,
    options: RequestInit,
    timeoutMs: number,
    label: string,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`${label} timed out after ${timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // --- Token Management ---

  /** Get a user access token (auto-refreshes if expired) */
  private async getUserToken(): Promise<string> {
    if (this.config.accessToken && this.config.accessTokenExpiry) {
      const expiry = new Date(this.config.accessTokenExpiry);
      // Refresh 5 minutes before expiry
      if (expiry.getTime() - Date.now() > 5 * 60 * 1000) {
        return this.config.accessToken;
      }
    }

    logger.info('Refreshing eBay user access token');

    const response = await this.fetchWithTimeout(
      EBAY_AUTH_URL,
      {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${this.getBasicAuth()}`,
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.config.refreshToken,
      }),
      },
      EBAY_API_TIMEOUT_MS,
      'eBay token refresh',
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`eBay token refresh failed (${response.status}): ${text}`);
    }

    const data = await response.json() as { access_token: string; expires_in: number };
    this.config.accessToken = data.access_token;
    this.config.accessTokenExpiry = new Date(Date.now() + data.expires_in * 1000).toISOString();
    this.saveConfig();

    return data.access_token;
  }

  /** Get an application token (client credentials - for Browse/Taxonomy APIs) */
  private async getApplicationToken(): Promise<string> {
    if (this.config.applicationToken && this.config.applicationTokenExpiry) {
      const expiry = new Date(this.config.applicationTokenExpiry);
      if (expiry.getTime() - Date.now() > 5 * 60 * 1000) {
        return this.config.applicationToken;
      }
    }

    logger.info('Getting eBay application token');

    const response = await this.fetchWithTimeout(
      EBAY_AUTH_URL,
      {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${this.getBasicAuth()}`,
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        scope: 'https://api.ebay.com/oauth/api_scope',
      }),
      },
      EBAY_API_TIMEOUT_MS,
      'eBay application token',
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`eBay application token failed (${response.status}): ${text}`);
    }

    const data = await response.json() as { access_token: string; expires_in: number };
    this.config.applicationToken = data.access_token;
    this.config.applicationTokenExpiry = new Date(Date.now() + data.expires_in * 1000).toISOString();
    this.saveConfig();

    return data.access_token;
  }

  // --- HTTP helpers ---

  private async apiCall(
    method: string,
    endpoint: string,
    tokenType: 'user' | 'application',
    body?: unknown,
  ): Promise<unknown> {
    const token = tokenType === 'user'
      ? await this.getUserToken()
      : await this.getApplicationToken();

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };

    const options: RequestInit = { method, headers };
    if (body && (method === 'POST' || method === 'PUT')) {
      options.body = JSON.stringify(body);
    }

    const url = `${EBAY_API_BASE}${endpoint}`;
    logger.debug({ method, url }, 'eBay API call');

    const response = await this.fetchWithTimeout(
      url,
      options,
      EBAY_API_TIMEOUT_MS,
      `eBay API ${method} ${endpoint}`,
    );

    if (response.status === 204) return { success: true };

    const text = await response.text();
    let responseData: unknown;
    try {
      responseData = JSON.parse(text);
    } catch {
      responseData = text;
    }

    if (!response.ok) {
      throw new Error(`eBay API error ${response.status} ${method} ${endpoint}: ${typeof responseData === 'string' ? responseData : JSON.stringify(responseData)}`);
    }

    return responseData;
  }

  // --- Search & Browse (Application token) ---

  async searchItems(query: string, options?: {
    categoryId?: string;
    sort?: string;
    limit?: number;
  }): Promise<unknown> {
    const params = new URLSearchParams({ q: query });
    if (options?.categoryId) params.set('category_ids', options.categoryId);
    if (options?.sort) params.set('sort', options.sort);
    if (options?.limit) params.set('limit', String(options.limit));
    return this.apiCall('GET', `/buy/browse/v1/item_summary/search?${params}`, 'application');
  }

  async getItem(itemId: string): Promise<unknown> {
    return this.apiCall('GET', `/buy/browse/v1/item/${encodeURIComponent(itemId)}`, 'application');
  }

  // --- Taxonomy (Application token) ---

  async getCategorySuggestions(query: string): Promise<unknown> {
    const params = new URLSearchParams({ q: query });
    return this.apiCall('GET', `/commerce/taxonomy/v1/category_tree/0/get_category_suggestions?${params}`, 'application');
  }

  async getItemAspects(categoryId: string): Promise<unknown> {
    const params = new URLSearchParams({ category_id: categoryId });
    return this.apiCall('GET', `/commerce/taxonomy/v1/category_tree/0/get_item_aspects_for_category?${params}`, 'application');
  }

  // --- Inventory (User token) ---

  async createInventoryItem(sku: string, itemData: unknown): Promise<unknown> {
    return this.apiCall('PUT', `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, 'user', itemData);
  }

  async getInventoryItem(sku: string): Promise<unknown> {
    return this.apiCall('GET', `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, 'user');
  }

  async getInventoryItems(limit?: number, offset?: number): Promise<unknown> {
    const params = new URLSearchParams();
    if (limit) params.set('limit', String(limit));
    if (offset) params.set('offset', String(offset));
    const qs = params.toString();
    return this.apiCall('GET', `/sell/inventory/v1/inventory_item${qs ? '?' + qs : ''}`, 'user');
  }

  async createOffer(offerData: unknown): Promise<unknown> {
    return this.apiCall('POST', '/sell/inventory/v1/offer', 'user', offerData);
  }

  async publishOffer(offerId: string): Promise<unknown> {
    return this.apiCall('POST', `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/publish`, 'user');
  }

  async withdrawOffer(offerId: string): Promise<unknown> {
    return this.apiCall('POST', `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/withdraw`, 'user');
  }

  async getOffers(sku: string): Promise<unknown> {
    const params = new URLSearchParams({ sku });
    return this.apiCall('GET', `/sell/inventory/v1/offer?${params}`, 'user');
  }

  // --- Fulfillment (User token) ---

  async getOrders(filter?: string): Promise<unknown> {
    const params = new URLSearchParams();
    if (filter) params.set('filter', filter);
    const qs = params.toString();
    return this.apiCall('GET', `/sell/fulfillment/v1/order${qs ? '?' + qs : ''}`, 'user');
  }

  async getOrder(orderId: string): Promise<unknown> {
    return this.apiCall('GET', `/sell/fulfillment/v1/order/${encodeURIComponent(orderId)}`, 'user');
  }

  async markShipped(orderId: string, trackingInfo: { trackingNumber: string; shippingCarrier: string }): Promise<unknown> {
    return this.apiCall('POST', `/sell/fulfillment/v1/order/${encodeURIComponent(orderId)}/shipping_fulfillment`, 'user', {
      lineItems: [], // eBay will default to all line items
      trackingNumber: trackingInfo.trackingNumber,
      shippingCarrierCode: trackingInfo.shippingCarrier,
    });
  }

  async issueRefund(orderId: string, amount: number, reason: string): Promise<unknown> {
    return this.apiCall('POST', `/sell/fulfillment/v1/order/${encodeURIComponent(orderId)}/issue_refund`, 'user', {
      reasonForRefund: reason,
      orderLevelRefundAmount: { value: String(amount), currency: 'USD' },
    });
  }

  // --- Account (User token) ---

  async getPolicies(type: string, marketplaceId?: string): Promise<unknown> {
    const params = new URLSearchParams();
    if (marketplaceId) params.set('marketplace_id', marketplaceId);
    const qs = params.toString();
    return this.apiCall('GET', `/sell/account/v1/${encodeURIComponent(type)}_policy${qs ? '?' + qs : ''}`, 'user');
  }

  // --- Compound operations ---

  /** Create inventory item + offer in one step */
  async createListing(params: {
    sku: string;
    title: string;
    description: string;
    condition: string;
    price: number;
    currency?: string;
    quantity: number;
    imageUrls: string[];
    categoryId: string;
    aspects?: Record<string, string[]>;
    marketplaceId?: string;
    fulfillmentPolicyId?: string;
    paymentPolicyId?: string;
    returnPolicyId?: string;
    merchantLocationKey?: string;
  }): Promise<{ inventoryResult: unknown; offerResult: unknown }> {
    const conditionEnum = mapCondition(params.condition);

    // Step 1: Create inventory item
    const inventoryItem = {
      availability: {
        shipToLocationAvailability: {
          quantity: params.quantity,
        },
      },
      condition: conditionEnum,
      product: {
        title: params.title,
        description: params.description,
        imageUrls: params.imageUrls,
        aspects: params.aspects,
      },
    };

    const inventoryResult = await this.createInventoryItem(params.sku, inventoryItem);

    // Step 2: Create offer
    const offer: Record<string, unknown> = {
      sku: params.sku,
      marketplaceId: params.marketplaceId || 'EBAY_US',
      format: 'FIXED_PRICE',
      listingDescription: params.description,
      availableQuantity: params.quantity,
      categoryId: params.categoryId,
      pricingSummary: {
        price: {
          value: String(params.price),
          currency: params.currency || 'USD',
        },
      },
    };

    if (params.fulfillmentPolicyId) offer.listingPolicies = {
      ...(offer.listingPolicies as object || {}),
      fulfillmentPolicyId: params.fulfillmentPolicyId,
    };
    if (params.paymentPolicyId) offer.listingPolicies = {
      ...(offer.listingPolicies as object || {}),
      paymentPolicyId: params.paymentPolicyId,
    };
    if (params.returnPolicyId) offer.listingPolicies = {
      ...(offer.listingPolicies as object || {}),
      returnPolicyId: params.returnPolicyId,
    };
    if (params.merchantLocationKey) offer.merchantLocationKey = params.merchantLocationKey;

    const offerResult = await this.createOffer(offer);

    return { inventoryResult, offerResult };
  }
}

// Map common condition strings to eBay condition enums
function mapCondition(condition: string): string {
  const lower = condition.toLowerCase();
  if (lower.includes('new')) return 'NEW';
  if (lower.includes('like new') || lower.includes('open box')) return 'LIKE_NEW';
  if (lower.includes('excellent') || lower.includes('refurbished')) return 'MANUFACTURER_REFURBISHED';
  if (lower.includes('very good')) return 'VERY_GOOD';
  if (lower.includes('good')) return 'GOOD';
  if (lower.includes('acceptable')) return 'ACCEPTABLE';
  if (lower.includes('parts') || lower.includes('not working')) return 'FOR_PARTS_OR_NOT_WORKING';
  return condition.toUpperCase().replace(/\s+/g, '_');
}
