import { z } from 'zod';

const registrationAgreementsSchema = z.object({
  acceptTermsAndPrivacy: z.boolean(),
  confirmAgeAndCapacity: z.boolean(),
  confirmUploadRights: z.boolean(),
  acknowledgeAiLimitations: z.boolean(),
  acknowledgeCreditsPolicy: z.boolean(),
  acceptArbitrationWaiver: z.boolean(),
  acknowledgePhotographerDisclaimer: z.boolean(),
  promotionalCommunicationsOptIn: z.boolean().optional(),
}).superRefine((value, context) => {
  const requiredFields: Array<keyof Omit<typeof value, 'promotionalCommunicationsOptIn'>> = [
    'acceptTermsAndPrivacy',
    'confirmAgeAndCapacity',
    'confirmUploadRights',
    'acknowledgeAiLimitations',
    'acknowledgeCreditsPolicy',
    'acceptArbitrationWaiver',
    'acknowledgePhotographerDisclaimer',
  ];

  for (const field of requiredFields) {
    if (!value[field]) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `${field} must be accepted`,
      });
    }
  }
});

export const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  name: z.string().min(1, 'Name is required').optional(),
  registrationAgreements: registrationAgreementsSchema,
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});
