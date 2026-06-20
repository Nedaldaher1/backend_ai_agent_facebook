/**
 * COD delivery fee, resolved SERVER-SIDE (the LLM never supplies it).
 *
 * A flat fee is added to every order. It is kept in integer milli-JOD
 * (1 JOD = 1000 milli) so the math stays integer and lossless (see
 * @/common/money.util). Change the value here to change it for all new orders;
 * existing orders keep their snapshot on the order row.
 */

/** Flat delivery fee in milli-JOD (2.000 JOD). */
export const DELIVERY_FEE_MILLI = 2000;
