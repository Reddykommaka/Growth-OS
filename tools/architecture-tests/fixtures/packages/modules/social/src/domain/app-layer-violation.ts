// VIOLATION: domain/ must not import application/ either.
import { service } from '../application/service.ts';
export const broken = service;
