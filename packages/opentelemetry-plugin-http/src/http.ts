/*!
 * Copyright 2019, OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { BasePlugin, isValid } from '@opentelemetry/core';
import {
  Span,
  SpanKind,
  SpanOptions,
  Attributes,
  CanonicalCode,
  Status,
} from '@opentelemetry/types';
import {
  ClientRequest,
  IncomingMessage,
  request,
  RequestOptions,
  ServerResponse,
} from 'http';
import * as semver from 'semver';
import * as shimmer from 'shimmer';
import * as url from 'url';
import {
  HttpPluginConfig,
  Http,
  Func,
  ResponseEndArgs,
  ParsedRequestOptions,
  HttpRequestArgs,
  Err,
} from './types';
import { Format } from './enums/Format';
import { AttributeNames } from './enums/AttributeNames';
import * as utils from './utils';

/**
 * Http instrumentation plugin for Opentelemetry
 */
export class HttpPlugin extends BasePlugin<Http> {
  readonly component: string;
  protected _config!: HttpPluginConfig;
  /** keep track on spans not ended */
  private readonly _spanNotEnded: WeakSet<Span>;

  constructor(readonly moduleName: string, readonly version: string) {
    super();
    // For now component is equal to moduleName but it can change in the future.
    this.component = this.moduleName;
    this._spanNotEnded = new WeakSet<Span>();
    this._config = {};
  }

  /** Patches HTTP incoming and outcoming request functions. */
  protected patch() {
    this._logger.debug(
      'applying patch to %s@%s',
      this.moduleName,
      this.version
    );

    shimmer.wrap(
      this._moduleExports,
      'request',
      this._getPatchOutgoingRequestFunction()
    );

    // In Node >=8, http.get calls a private request method, therefore we patch it
    // here too.
    if (semver.satisfies(this.version, '>=8.0.0')) {
      shimmer.wrap(
        this._moduleExports,
        'get',
        this._getPatchOutgoingGetFunction(request)
      );
    }

    if (
      this._moduleExports &&
      this._moduleExports.Server &&
      this._moduleExports.Server.prototype
    ) {
      shimmer.wrap(
        this._moduleExports.Server.prototype,
        'emit',
        this._getPatchIncomingRequestFunction()
      );
    } else {
      this._logger.error(
        'Could not apply patch to %s.emit. Interface is not as expected.',
        this.moduleName
      );
    }

    return this._moduleExports;
  }

  /** Unpatches all HTTP patched function. */
  protected unpatch(): void {
    shimmer.unwrap(this._moduleExports, 'request');
    if (semver.satisfies(this.version, '>=8.0.0')) {
      shimmer.unwrap(this._moduleExports, 'get');
    }
    if (
      this._moduleExports &&
      this._moduleExports.Server &&
      this._moduleExports.Server.prototype
    ) {
      shimmer.unwrap(this._moduleExports.Server.prototype, 'emit');
    }
  }

  /**
   * Creates spans for incoming requests, restoring spans' context if applied.
   */
  protected _getPatchIncomingRequestFunction() {
    return (original: (event: string, ...args: unknown[]) => boolean) => {
      return this._incomingRequestFunction(original);
    };
  }

  /**
   * Creates spans for outgoing requests, sending spans' context for distributed
   * tracing.
   */
  protected _getPatchOutgoingRequestFunction() {
    return (original: Func<ClientRequest>): Func<ClientRequest> => {
      return this._outgoingRequestFunction(original);
    };
  }

  protected _getPatchOutgoingGetFunction(
    clientRequest: (
      options: RequestOptions | string | URL,
      ...args: HttpRequestArgs
    ) => ClientRequest
  ) {
    return (original: Func<ClientRequest>): Func<ClientRequest> => {
      // Re-implement http.get. This needs to be done (instead of using
      // getPatchOutgoingRequestFunction to patch it) because we need to
      // set the trace context header before the returned ClientRequest is
      // ended. The Node.js docs state that the only differences between
      // request and get are that (1) get defaults to the HTTP GET method and
      // (2) the returned request object is ended immediately. The former is
      // already true (at least in supported Node versions up to v10), so we
      // simply follow the latter. Ref:
      // https://nodejs.org/dist/latest/docs/api/http.html#http_http_get_options_callback
      // https://github.com/googleapis/cloud-trace-nodejs/blob/master/src/plugins/plugin-http.ts#L198
      return function outgoingGetRequest<
        T extends RequestOptions | string | URL
      >(options: T, ...args: HttpRequestArgs): ClientRequest {
        const req = clientRequest(options, ...args);
        req.end();
        return req;
      };
    };
  }

  /**
   * Injects span's context to header for distributed tracing and finishes the
   * span when the response is finished.
   * @param request The original request object.
   * @param options The arguments to the original function.
   * @param span representing the current operation
   */
  private _getMakeRequestTraceFunction(
    request: ClientRequest,
    options: ParsedRequestOptions,
    span: Span
  ): Func<ClientRequest> {
    return (): ClientRequest => {
      this._logger.debug('makeRequestTrace by injecting context into header');

      const host = options.hostname || options.host || 'localhost';
      const method = options.method ? options.method.toUpperCase() : 'GET';
      const headers = options.headers || {};
      const userAgent = headers['user-agent'];

      span.setAttributes({
        [AttributeNames.HTTP_URL]: utils.getAbsoluteUrl(
          options,
          headers,
          `${this.component}:`
        ),
        [AttributeNames.HTTP_HOSTNAME]: host,
        [AttributeNames.HTTP_METHOD]: method,
        [AttributeNames.HTTP_PATH]: options.path || '/',
      });

      if (userAgent !== undefined) {
        span.setAttribute(AttributeNames.HTTP_USER_AGENT, userAgent);
      }

      request.on(
        'response',
        (
          response: IncomingMessage & { aborted?: boolean; req: ClientRequest }
        ) => {
          if (response.statusCode) {
            span.setAttributes({
              [AttributeNames.HTTP_STATUS_CODE]: response.statusCode,
              [AttributeNames.HTTP_STATUS_TEXT]: response.statusMessage,
            });
          }

          this._tracer.bind(response);
          this._logger.debug('outgoingRequest on response()');
          response.on('end', () => {
            this._logger.debug('outgoingRequest on end()');
            let status: Status;

            if (response.aborted && !response.complete) {
              status = { code: CanonicalCode.ABORTED };
            } else {
              status = utils.parseResponseStatus(response.statusCode!);
            }

            span.setStatus(status);

            if (this._config.applyCustomAttributesOnSpan) {
              this._safeExecute(
                span,
                () =>
                  this._config.applyCustomAttributesOnSpan!(
                    span,
                    request,
                    response
                  ),
                false
              );
            }

            this._closeHttpSpan(span);
          });
          response.on('error', (error: Err) => {
            utils.setSpanWithError(span, error, response);
            this._closeHttpSpan(span);
          });
        }
      );
      request.on('close', () => {
        if (!request.aborted) {
          this._closeHttpSpan(span);
        }
      });
      request.on('error', (error: Err) => {
        utils.setSpanWithError(span, error, request);
        this._closeHttpSpan(span);
      });

      this._logger.debug('makeRequestTrace return request');
      return request;
    };
  }

  private _incomingRequestFunction(
    original: (event: string, ...args: unknown[]) => boolean
  ) {
    const plugin = this;
    return function incomingRequest(
      this: {},
      event: string,
      ...args: unknown[]
    ): boolean {
      // Only traces request events
      if (event !== 'request') {
        return original.apply(this, [event, ...args]);
      }

      const request = args[0] as IncomingMessage;
      const response = args[1] as ServerResponse;
      const pathname = request.url
        ? url.parse(request.url).pathname || '/'
        : '/';
      const method = request.method || 'GET';

      plugin._logger.debug('%s plugin incomingRequest', plugin.moduleName);

      if (
        utils.isIgnored(
          pathname,
          plugin._config.ignoreIncomingPaths,
          (e: Error) =>
            plugin._logger.error('caught ignoreIncomingPaths error: ', e)
        )
      ) {
        return original.apply(this, [event, ...args]);
      }

      const propagation = plugin._tracer.getHttpTextFormat();
      const headers = request.headers;
      const spanOptions: SpanOptions = {
        kind: SpanKind.SERVER,
      };

      const spanContext = propagation.extract(Format.HTTP, headers);
      if (spanContext && isValid(spanContext)) {
        spanOptions.parent = spanContext;
      }

      const span = plugin._startHttpSpan(`${method} ${pathname}`, spanOptions);

      return plugin._tracer.withSpan(span, () => {
        plugin._tracer.bind(request);
        plugin._tracer.bind(response);

        // Wraps end (inspired by:
        // https://github.com/GoogleCloudPlatform/cloud-trace-nodejs/blob/master/src/plugins/plugin-connect.ts#L75)
        const originalEnd = response.end;
        response.end = function(
          this: ServerResponse,
          ...args: ResponseEndArgs
        ) {
          response.end = originalEnd;
          // Cannot pass args of type ResponseEndArgs,
          // tslint complains "Expected 1-2 arguments, but got 1 or more.", it does not make sense to me
          const returned = plugin._safeExecute(
            span,
            // tslint:disable-next-line:no-any
            () => response.end.apply(this, arguments as any),
            true
          );
          const requestUrl = request.url ? url.parse(request.url) : null;
          const hostname = headers.host
            ? headers.host.replace(/^(.*)(\:[0-9]{1,5})/, '$1')
            : 'localhost';
          const userAgent = headers['user-agent'];

          const attributes: Attributes = {
            [AttributeNames.HTTP_URL]: utils.getAbsoluteUrl(
              requestUrl,
              headers,
              `${plugin.component}:`
            ),
            [AttributeNames.HTTP_HOSTNAME]: hostname,
            [AttributeNames.HTTP_METHOD]: method,
            [AttributeNames.HTTP_STATUS_CODE]: response.statusCode,
            [AttributeNames.HTTP_STATUS_TEXT]: response.statusMessage,
          };

          if (requestUrl) {
            attributes[AttributeNames.HTTP_PATH] = requestUrl.path || '/';
            attributes[AttributeNames.HTTP_ROUTE] = requestUrl.pathname || '/';
          }

          if (userAgent !== undefined) {
            attributes[AttributeNames.HTTP_USER_AGENT] = userAgent;
          }

          span
            .setAttributes(attributes)
            .setStatus(utils.parseResponseStatus(response.statusCode));

          if (plugin._config.applyCustomAttributesOnSpan) {
            plugin._safeExecute(
              span,
              () =>
                plugin._config.applyCustomAttributesOnSpan!(
                  span,
                  request,
                  response
                ),
              false
            );
          }

          plugin._closeHttpSpan(span);
          return returned;
        };

        return plugin._safeExecute(
          span,
          () => original.apply(this, [event, ...args]),
          true
        );
      });
    };
  }

  private _outgoingRequestFunction(
    original: Func<ClientRequest>
  ): Func<ClientRequest> {
    const plugin = this;
    return function outgoingRequest(
      this: {},
      options: RequestOptions | string,
      ...args: unknown[]
    ): ClientRequest {
      if (!utils.isValidOptionsType(options)) {
        return original.apply(this, [options, ...args]);
      }

      const { origin, pathname, method, optionsParsed } = utils.getRequestInfo(
        options,
        typeof args[0] === 'object' && typeof options === 'string'
          ? (args.shift() as RequestOptions)
          : undefined
      );

      options = optionsParsed;

      if (
        utils.isOpenTelemetryRequest(options) ||
        utils.isIgnored(
          origin + pathname,
          plugin._config.ignoreOutgoingUrls,
          (e: Error) =>
            plugin._logger.error('caught ignoreOutgoingUrls error: ', e)
        )
      ) {
        return original.apply(this, [options, ...args]);
      }

      const currentSpan = plugin._tracer.getCurrentSpan();
      const operationName = `${method} ${pathname}`;
      const spanOptions: SpanOptions = {
        kind: SpanKind.CLIENT,
        parent: currentSpan ? currentSpan : undefined,
      };

      const span = plugin._startHttpSpan(operationName, spanOptions);
      plugin._tracer
        .getHttpTextFormat()
        .inject(span.context(), Format.HTTP, options.headers);

      const request: ClientRequest = plugin._safeExecute(
        span,
        () => original.apply(this, [options, ...args]),
        true
      );

      plugin._logger.debug('%s plugin outgoingRequest', plugin.moduleName);
      plugin._tracer.bind(request);

      // Checks if this outgoing request is part of an operation by checking
      // if there is a current span, if so, we create a child span. In
      // case there is no active span, this means that the outgoing request is
      // the first operation, therefore we create a span and call withSpan method.
      if (!currentSpan) {
        plugin._logger.debug('outgoingRequest starting a span without context');
        return plugin._tracer.withSpan(
          span,
          plugin._getMakeRequestTraceFunction(request, options, span)
        );
      } else {
        plugin._logger.debug('outgoingRequest starting a child span');
        return plugin._getMakeRequestTraceFunction(request, options, span)();
      }
    };
  }

  private _startHttpSpan(name: string, options: SpanOptions) {
    const span = this._tracer
      .startSpan(name, options)
      .setAttribute(AttributeNames.COMPONENT, this.component);
    this._spanNotEnded.add(span);
    return span;
  }

  private _closeHttpSpan(span: Span) {
    if (!this._spanNotEnded.has(span)) {
      return;
    }

    span.end();
    this._spanNotEnded.delete(span);
  }

  private _safeExecute<
    T extends (...args: unknown[]) => ReturnType<T>,
    K extends boolean
  >(
    span: Span,
    execute: T,
    rethrow: K
  ): K extends true ? ReturnType<T> : ReturnType<T> | void;
  private _safeExecute<T extends (...args: unknown[]) => ReturnType<T>>(
    span: Span,
    execute: T,
    rethrow: boolean
  ): ReturnType<T> | void {
    try {
      return execute();
    } catch (error) {
      if (rethrow) {
        utils.setSpanWithError(span, error);
        this._closeHttpSpan(span);
        throw error;
      }
      this._logger.error('caught error ', error);
    }
  }
}

export const plugin = new HttpPlugin('http', process.versions.node);
