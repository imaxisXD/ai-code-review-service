import { CircuitBreakerState, CircuitBreakerStatus } from './types.js';
import { logger } from '../../utils/logger.js';

/**
 * Circuit Breaker for handling API overload errors
 *
 * Implements the circuit breaker pattern to protect against cascading failures
 * when the Anthropic API is overloaded (HTTP 529 errors).
 */
export class CircuitBreaker {
  private state: CircuitBreakerState;

  constructor() {
    this.state = {
      isOpen: false,
      failureCount: 0,
      lastFailureTime: 0,
      resetTimeoutMs: 300000, // 5 minutes for rate limit recovery
      maxFailures: 2, // Open circuit after 2 consecutive rate limit failures
    };
  }

  /**
   * Check if the circuit breaker allows the operation
   */
  canExecute(): boolean {
    const now = Date.now();

    if (this.state.isOpen) {
      if (now - this.state.lastFailureTime > this.state.resetTimeoutMs) {
        // Reset circuit breaker
        this.state.isOpen = false;
        this.state.failureCount = 0;
        logger.info('Circuit breaker reset - attempting API calls again');
        return true;
      } else {
        logger.warn('Circuit breaker is open - blocking API call', {
          timeUntilReset: this.state.resetTimeoutMs - (now - this.state.lastFailureTime),
        });
        return false;
      }
    }

    return true;
  }

  /**
   * Record a successful operation
   */
  recordSuccess(): void {
    this.state.failureCount = 0;
  }

  /**
   * Record a failure and potentially open the circuit
   */
  recordFailure(isOverloadError: boolean): void {
    if (isOverloadError) {
      this.state.failureCount++;
      this.state.lastFailureTime = Date.now();

      if (this.state.failureCount >= this.state.maxFailures) {
        this.state.isOpen = true;
        logger.warn('Circuit breaker opened due to repeated API overload errors', {
          failureCount: this.state.failureCount,
        });
      }
    }
  }

  /**
   * Get current circuit breaker status for monitoring
   */
  getStatus(): CircuitBreakerStatus {
    const now = Date.now();
    return {
      isOpen: this.state.isOpen,
      failureCount: this.state.failureCount,
      lastFailureTime: this.state.lastFailureTime,
      timeUntilReset: this.state.isOpen
        ? Math.max(0, this.state.resetTimeoutMs - (now - this.state.lastFailureTime))
        : 0,
    };
  }

  /**
   * Check if an error is an overload error
   */
  static isOverloadError(error: Error): boolean {
    const errorMessage = error.message.toLowerCase();
    return (
      errorMessage.includes('overload') ||
      errorMessage.includes('529') ||
      errorMessage.includes('rate limit') ||
      errorMessage.includes('exceed the rate limit') ||
      errorMessage.includes('tokens per minute') ||
      errorMessage.includes('too many requests') ||
      errorMessage.includes('quota exceeded')
    );
  }
}
