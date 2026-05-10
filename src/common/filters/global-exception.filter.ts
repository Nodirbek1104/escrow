import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import {
  EntityNotFoundError,
  QueryFailedError,
  TypeORMError,
} from 'typeorm';
import { JsonWebTokenError, TokenExpiredError } from 'jsonwebtoken';
import { ThrottlerException } from '@nestjs/throttler';

/**
 * One filter to rule them all. Translates raw infrastructure errors
 * (TypeORM, JWT, throttler, axios, plain Errors) into a stable JSON
 * shape that frontends can rely on, while logging the full original
 * stack on the server.
 *
 * Outgoing shape:
 *   { statusCode, message, errorCode?, hint? }
 *
 * `message` is always something the user can read in Uzbek. `errorCode`
 * lets the FE pick a specific UI (e.g. payment errors). DB / connection
 * details never leak — they live in server logs only.
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('GlobalExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<any>();
    const path = req?.url ?? '';
    const method = req?.method ?? '';

    const mapped = this.toResponse(exception);
    const errorCode = (mapped.body as any)?.errorCode;
    if (mapped.status >= 500) {
      this.logger.error(
        `[${method} ${path}] ${errorCode ?? 'unknown'}: ${this.describe(exception)}`,
        (exception as Error)?.stack,
      );
    } else if (mapped.status === 401 || mapped.status === 403) {
      // 4xx is expected at runtime — log at warn so they don't drown logs.
      this.logger.warn(`[${method} ${path}] ${mapped.status} ${errorCode ?? ''}`);
    }

    res.status(mapped.status).json(mapped.body);
  }

  // ───────────────────────────────────────────────────────────────────────

  private toResponse(exception: unknown): {
    status: number;
    body: Record<string, any>;
  } {
    // 1) Throttler — must come *before* HttpException because it
    //    extends HttpException; otherwise its raw "ThrottlerException:
    //    Too Many Requests" message leaks through to the FE.
    if (exception instanceof ThrottlerException) {
      return {
        status: HttpStatus.TOO_MANY_REQUESTS,
        body: {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message:
            'Juda ko\'p so\'rov yuborildi. Iltimos, biroz kuting va qaytadan urinib ko\'ring.',
          errorCode: 'too_many_requests',
        },
      };
    }

    // 2) NestJS HttpException — pass through, but normalise message shape.
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const r = exception.getResponse();
      const body =
        typeof r === 'string'
          ? { statusCode: status, message: r }
          : { statusCode: status, ...(r as object) };
      // class-validator returns { message: string[] } — flatten so toast can display
      if (Array.isArray((body as any).message)) {
        (body as any).message =
          ((body as any).message as string[]).filter(Boolean)[0] ||
          'So\'rovda xatolik';
      }
      // 401's default message is just "Unauthorized" — make it speak
      // Uzbek when no specific message is provided.
      if (status === HttpStatus.UNAUTHORIZED) {
        const msg = (body as any).message;
        if (!msg || msg === 'Unauthorized') {
          (body as any).message =
            'Sessiya tugadi yoki avtorizatsiya xato.';
          (body as any).errorCode =
            (body as any).errorCode ?? 'unauthorized';
        }
      }
      return { status, body };
    }

    // 3) JWT errors — clear "session expired" semantics.
    if (
      exception instanceof TokenExpiredError ||
      exception instanceof JsonWebTokenError ||
      (exception as any)?.name === 'TokenExpiredError' ||
      (exception as any)?.name === 'JsonWebTokenError'
    ) {
      return {
        status: HttpStatus.UNAUTHORIZED,
        body: {
          statusCode: HttpStatus.UNAUTHORIZED,
          message: "Sessiya muddati tugadi, qaytadan tizimga kiring.",
          errorCode: 'token_expired',
        },
      };
    }

    // 4) TypeORM specifics — entity not found, query failures, FK / unique violations.
    if (exception instanceof EntityNotFoundError) {
      return {
        status: HttpStatus.NOT_FOUND,
        body: {
          statusCode: HttpStatus.NOT_FOUND,
          message: 'Ma\'lumot topilmadi.',
          errorCode: 'not_found',
        },
      };
    }
    if (exception instanceof QueryFailedError) {
      const pgCode = (exception as any).code as string | undefined;
      // 23505 unique_violation, 23503 foreign_key_violation, 23502 not_null,
      // 22P02 invalid_text_representation
      if (pgCode === '23505') {
        return {
          status: HttpStatus.CONFLICT,
          body: {
            statusCode: HttpStatus.CONFLICT,
            message: 'Bu ma\'lumot allaqachon mavjud.',
            errorCode: 'duplicate',
          },
        };
      }
      if (pgCode === '23503') {
        return {
          status: HttpStatus.BAD_REQUEST,
          body: {
            statusCode: HttpStatus.BAD_REQUEST,
            message: 'Bog\'liq ma\'lumot topilmadi yoki noto\'g\'ri.',
            errorCode: 'fk_violation',
          },
        };
      }
      if (pgCode === '23502') {
        return {
          status: HttpStatus.BAD_REQUEST,
          body: {
            statusCode: HttpStatus.BAD_REQUEST,
            message: 'Majburiy maydon to\'ldirilmagan.',
            errorCode: 'missing_required',
          },
        };
      }
      if (pgCode === '22P02' || pgCode === '22023') {
        return {
          status: HttpStatus.BAD_REQUEST,
          body: {
            statusCode: HttpStatus.BAD_REQUEST,
            message: 'Yuborilgan qiymat noto\'g\'ri formatda.',
            errorCode: 'bad_format',
          },
        };
      }
      // Generic DB failure — never leak the SQL error text.
      return {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        body: {
          statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
          message: 'Ma\'lumotlarni saqlashda xatolik yuz berdi.',
          errorCode: 'db_error',
        },
      };
    }
    if (exception instanceof TypeORMError) {
      return {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        body: {
          statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
          message: 'Ma\'lumotlar bazasi xatosi yuz berdi.',
          errorCode: 'db_error',
        },
      };
    }

    // 5) Network/upstream issues from axios calls (Paylov, Eskiz...).
    if (this.isAxiosError(exception)) {
      const status = (exception as any).response?.status;
      if (status === 401 || status === 403) {
        return {
          status: HttpStatus.BAD_GATEWAY,
          body: {
            statusCode: HttpStatus.BAD_GATEWAY,
            message: 'Tashqi xizmat avtorizatsiyasida xatolik.',
            errorCode: 'upstream_auth',
          },
        };
      }
      return {
        status: HttpStatus.BAD_GATEWAY,
        body: {
          statusCode: HttpStatus.BAD_GATEWAY,
          message: 'Tashqi xizmat hozir javob bermayapti, qaytadan urinib ko\'ring.',
          errorCode: 'upstream_unavailable',
        },
      };
    }

    // 6) Anything else — generic 500 with a safe message.
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: {
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        message: 'Server xatosi yuz berdi. Iltimos, qaytadan urinib ko\'ring.',
        errorCode: 'internal_error',
      },
    };
  }

  private isAxiosError(e: unknown): boolean {
    return (
      typeof e === 'object' &&
      e != null &&
      (e as any).isAxiosError === true
    );
  }

  private describe(e: unknown): string {
    if (e instanceof Error) return `${e.name}: ${e.message}`;
    try {
      return JSON.stringify(e);
    } catch {
      return String(e);
    }
  }
}
