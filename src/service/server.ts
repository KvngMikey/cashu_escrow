import { createServer, type IncomingMessage, type Server } from 'node:http';

import { EscrowError, isEscrowError } from '../lib/errors.ts';
import type { CoordinationOperator } from '../operator/coordinator.ts';
import { Nip98Authenticator } from './nip98.ts';
import {
  CoordinationId,
  FundingSubmissionBody,
  PayoutTargetBody,
  QuoteRequestBody,
} from './schemas.ts';

const MAX_BODY_BYTES = 256 * 1024;

type ServiceOperator = Pick<
  CoordinationOperator,
  | 'createQuote'
  | 'fundingInstructions'
  | 'submitFunding'
  | 'putPayout'
  | 'status'
  | 'refund'
>;

export type ServiceRequest = {
  method: string;
  path: string;
  authorization?: string;
  body?: Uint8Array;
};

export type ServiceResponse = {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: string;
};

export class EscrowHttpService {
  readonly #operator: ServiceOperator;
  readonly #authenticator: Nip98Authenticator;
  readonly #baseUrl: string;
  readonly #openApi: unknown;
  readonly #clock: () => number;

  constructor(input: {
    operator: ServiceOperator;
    serviceBaseUrl: string;
    openApi: unknown;
    authenticator?: Nip98Authenticator;
    clock?: () => number;
  }) {
    this.#operator = input.operator;
    this.#authenticator = input.authenticator ?? new Nip98Authenticator();
    this.#baseUrl = input.serviceBaseUrl.replace(/\/$/, '');
    this.#openApi = input.openApi;
    this.#clock = input.clock ?? (() => Math.floor(Date.now() / 1_000));
  }

  async handle(request: ServiceRequest): Promise<ServiceResponse> {
    const method = request.method.toUpperCase();
    const body = request.body ?? new Uint8Array();
    try {
      if (body.length > MAX_BODY_BYTES) {
        throw new EscrowError('content_invalid', 'request body is too large');
      }
      if (request.path === '/v1/openapi.json' && method === 'GET') {
        return json(200, this.#openApi);
      }
      const now = this.#clock();
      const caller = this.#authenticator.authenticate({
        authorization: request.authorization,
        method,
        url: `${this.#baseUrl}${request.path}`,
        body,
        now,
      });

      if (request.path === '/v1/quotes' && method === 'POST') {
        const input = parseBody(QuoteRequestBody, body);
        return json(200, await this.#operator.createQuote(input, now, caller));
      }

      const route = coordinationRoute(request.path);
      if (route === null) return errorResponse(404, undefined);
      const id = CoordinationId.safeParse(route.id);
      if (!id.success) return errorResponse(404, undefined);

      if (route.suffix === '/funding-instructions' && method === 'GET') {
        return json(
          200,
          await this.#operator.fundingInstructions(id.data, caller, now)
        );
      }
      if (route.suffix === '/funding' && method === 'POST') {
        const input = parseBody(FundingSubmissionBody, body);
        return json(
          200,
          await this.#operator.submitFunding({
            coordinationId: id.data,
            caller,
            token: input.token,
            now,
          })
        );
      }
      if (route.suffix === '/payout' && method === 'PUT') {
        const payout = parseBody(PayoutTargetBody, body);
        await this.#operator.putPayout({
          coordinationId: id.data,
          caller,
          payout,
          now,
        });
        return { status: 204, headers: {}, body: '' };
      }
      if (route.suffix === '' && method === 'GET') {
        return json(200, await this.#operator.status(id.data, caller));
      }
      if (route.suffix === '/refund' && method === 'GET') {
        return json(
          200,
          await this.#operator.refund({
            coordinationId: id.data,
            caller,
            now,
          })
        );
      }
      return errorResponse(404, id.data);
    } catch (error) {
      return mapError(error);
    }
  }
}

export function startHttpServer(input: {
  service: EscrowHttpService;
  host: string;
  port: number;
}): Promise<Server> {
  const server = createServer((request, response) => {
    void readRequestBody(request)
      .then((body) =>
        input.service.handle({
          method: request.method ?? 'GET',
          path: request.url ?? '/',
          ...(request.headers.authorization === undefined
            ? {}
            : { authorization: request.headers.authorization }),
          body,
        })
      )
      .then((result) => {
        response.writeHead(result.status, result.headers);
        response.end(result.body);
      })
      .catch((error: unknown) => {
        const result = mapError(error);
        response.writeHead(result.status, result.headers);
        response.end(result.body);
      });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(input.port, input.host, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

export async function readRequestBody(
  request: IncomingMessage
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    let rejected = false;
    request.on('data', (value: unknown) => {
      if (rejected) return;
      const chunk =
        typeof value === 'string'
          ? Buffer.from(value)
          : value instanceof Uint8Array
            ? value
            : null;
      if (chunk === null) {
        rejected = true;
        reject(new EscrowError('content_invalid', 'request body is invalid'));
        request.resume();
        return;
      }
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejected = true;
        reject(new EscrowError('content_invalid', 'request body is too large'));
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.once('end', () => {
      if (!rejected) resolve(Buffer.concat(chunks));
    });
    request.once('error', reject);
  });
}

function parseBody<T>(
  schema: {
    safeParse(value: unknown): { success: true; data: T } | { success: false };
  },
  body: Uint8Array
): T {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(body).toString('utf8'));
  } catch {
    throw new EscrowError('content_invalid', 'request body is invalid JSON');
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new EscrowError('content_invalid', 'request body failed its schema');
  }
  return parsed.data;
}

function coordinationRoute(
  path: string
): { id: string; suffix: string } | null {
  const match = /^\/v1\/coordinations\/([^/?]+)(\/[^?]*)?(?:\?.*)?$/.exec(path);
  if (match === null || match[1] === undefined) return null;
  return { id: match[1], suffix: match[2] ?? '' };
}

function mapError(error: unknown): ServiceResponse {
  if (!isEscrowError(error)) return errorResponse(500, undefined);
  const coordinationId = error.swapId;
  if (error.category === 'request_unauthorized') {
    return errorResponse(401, coordinationId);
  }
  if (error.category === 'rate_limited') {
    return errorResponse(429, coordinationId);
  }
  if (error.category === 'coordination_not_found') {
    return errorResponse(404, coordinationId);
  }
  if (
    error.category === 'content_invalid' ||
    error.category === 'event_invalid'
  ) {
    return errorResponse(422, coordinationId);
  }
  if (
    error.category === 'custody_invalid' ||
    error.category === 'custody_conflict'
  ) {
    return errorResponse(409, coordinationId);
  }
  return errorResponse(503, coordinationId);
}

function errorResponse(
  status: number,
  coordinationId: string | undefined
): ServiceResponse {
  return json(status, {
    category:
      status === 401
        ? 'request_unauthorized'
        : status === 429
          ? 'rate_limited'
          : status === 404
            ? 'coordination_not_found'
            : status === 422
              ? 'content_invalid'
              : status === 409
                ? 'custody_conflict'
                : 'service_unavailable',
    coordination_id: coordinationId ?? null,
  });
}

function json(status: number, value: unknown): ServiceResponse {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  };
}
