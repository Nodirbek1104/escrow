import { Logger } from '@nestjs/common';
import axios, { AxiosError } from 'axios';

const logger = new Logger('PaymentErrorHandler');

/**
 * Paylov API dan keladigan xatolarni yagona formatga keltiradi
 */
export function handlePaymentError(error: unknown) {
  if (axios.isAxiosError(error)) {
    const axiosError = error as AxiosError<any>;
    const errorData = axiosError.response?.data;

    logger.error(`Paylov API Error: ${JSON.stringify(errorData || axiosError.message)}`);

    // Agar Paylov xato obyekti qaytargan bo'lsa (code, message bilan)
    if (errorData && errorData.error) {
      return {
        result: null,
        error: errorData.error,
      };
    }

    // Server xatosi yoki ulanishdagi xatolik
    return {
      result: null,
      error: {
        code: 'service_unavailable',
        message: axiosError.message,
      },
    };
  }

  // Tizimning ichki kutilmagan xatosi
  logger.error(`System Error: ${error}`);
  return {
    result: null,
    error: {
      code: 'internal_error',
      message: 'Something went wrong',
    },
  };
}