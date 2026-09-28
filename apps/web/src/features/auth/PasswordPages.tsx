import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  forgotPasswordSchema,
  resetPasswordSchema,
  type ForgotPasswordInput,
  type ResetPasswordInput,
} from '@tm/shared';
import { ApiError, api } from '@/lib/api';
import { Button, Card, FieldError, Input, Label, Spinner } from '@/components/ui/primitives';

export function ForgotPasswordPage() {
  const [sent, setSent] = useState(false);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ForgotPasswordInput>({
    resolver: zodResolver(forgotPasswordSchema),
    defaultValues: { email: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    await api.post('/auth/forgot', values);
    // The same confirmation either way, so this page cannot be used to test
    // whether an address is registered.
    setSent(true);
  });

  return (
    <Shell title="Reset your password">
      {sent ? (
        <p className="text-sm text-ink-muted">
          If that address belongs to an account, a reset link is on its way. The link expires
          shortly, so use it soon.
        </p>
      ) : (
        <form onSubmit={onSubmit} noValidate className="space-y-4">
          <div>
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" autoComplete="username" autoFocus {...register('email')} />
            <FieldError message={errors.email?.message} />
          </div>
          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? <Spinner /> : null}
            Send the reset link
          </Button>
        </form>
      )}

      <BackToSignIn />
    </Shell>
  );
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [formError, setFormError] = useState<string | null>(null);
  const token = params.get('token') ?? '';

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ResetPasswordInput>({
    resolver: zodResolver(resetPasswordSchema),
    defaultValues: { token, password: '', confirmPassword: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await api.post('/auth/reset', values);
      navigate('/login', { replace: true });
    } catch (error) {
      setFormError(
        error instanceof ApiError ? error.message : 'Could not set that password. Try again.',
      );
    }
  });

  if (!token) {
    return (
      <Shell title="Set a new password">
        <p className="text-sm text-ink-muted">
          That link is missing its token. Ask for a new reset email.
        </p>
        <BackToSignIn />
      </Shell>
    );
  }

  return (
    <Shell title="Set a new password">
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        <input type="hidden" {...register('token')} />

        <div>
          <Label htmlFor="password" hint="at least 10 characters">
            New password
          </Label>
          <Input id="password" type="password" autoComplete="new-password" autoFocus {...register('password')} />
          <FieldError message={errors.password?.message} />
        </div>

        <div>
          <Label htmlFor="confirmPassword">Confirm it</Label>
          <Input
            id="confirmPassword"
            type="password"
            autoComplete="new-password"
            {...register('confirmPassword')}
          />
          <FieldError message={errors.confirmPassword?.message} />
        </div>

        {formError ? (
          <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
            {formError}
          </p>
        ) : null}

        <Button type="submit" className="w-full" disabled={isSubmitting}>
          {isSubmitting ? <Spinner /> : null}
          Save the password
        </Button>
      </form>
      <BackToSignIn />
    </Shell>
  );
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-full items-center justify-center bg-canvas px-4 py-10">
      <Card className="w-full max-w-sm p-6">
        <h1 className="mb-5 text-lg font-semibold tracking-tight">{title}</h1>
        {children}
      </Card>
    </div>
  );
}

function BackToSignIn() {
  return (
    <Link
      to="/login"
      className="mt-4 block text-center text-xs text-ink-muted underline-offset-2 hover:text-accent hover:underline"
    >
      Back to sign in
    </Link>
  );
}
