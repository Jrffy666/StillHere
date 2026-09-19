'use client';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, errorMessage } from '@/lib/api';
import type { Trip, User } from '@/lib/types';

export function JourneyPrivacy({
  trip,
  user,
  token,
}: {
  trip: Trip;
  user: User;
  token: string;
}) {
  const cache = useQueryClient(),
    [status, setStatus] = useState(''),
    [busy, setBusy] = useState(false),
    [confirmation, setConfirmation] = useState('');
  const [subject, setSubject] = useState(''),
    [category, setCategory] = useState('unsafe-conduct');
  const people = [
    trip.rider,
    trip.guardian,
    ...trip.contributions.map((item) => item.guardian),
  ].filter(
    (person, index, items) =>
      person &&
      person.id !== user.id &&
      items.findIndex((item) => item?.id === person.id) === index,
  );
  async function run(work: () => Promise<void>) {
    setBusy(true);
    setStatus('');
    try {
      await work();
    } catch (e) {
      setStatus(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="journey-privacy">
      <summary>Privacy & report a concern</summary>
      {trip.privacyExpiresAt && (
        <p>
          Private journey details expire on{' '}
          {new Date(trip.privacyExpiresAt).toLocaleDateString()}.
        </p>
      )}
      {people.length > 0 && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await api('/reports', token, {
                tripId: trip.id,
                subjectId: subject || people[0]!.id,
                category,
                idempotencyKey: crypto.randomUUID(),
              });
              setStatus(
                'Report received for operator review. This does not send an emergency alert.',
              );
            });
          }}
        >
          <label>
            Person
            <select
              value={subject || people[0]!.id}
              onChange={(e) => setSubject(e.target.value)}
            >
              {people.map(
                (person) =>
                  person && (
                    <option key={person.id} value={person.id}>
                      {person.name}
                    </option>
                  ),
              )}
            </select>
          </label>
          <label>
            Concern
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              <option value="unsafe-conduct">Unsafe conduct</option>
              <option value="harassment">Harassment</option>
              <option value="privacy">Privacy</option>
              <option value="spam">Spam</option>
              <option value="reward-abuse">Reward abuse</option>
            </select>
          </label>
          <Button variant="outline" disabled={busy || trip.demo}>
            Submit report
          </Button>
        </form>
      )}
      {user.id === trip.rider.id &&
        ['arrived', 'cancelled'].includes(trip.status) && (
          <>
            <p>
              Delete this closed journey’s private details for all participants.
              Public chain records remain. Export any details you need from your
              account first.
            </p>
            <Input
              aria-label="Type DELETE JOURNEY"
              placeholder="Type DELETE JOURNEY"
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
            />
            <Button
              variant="destructive"
              disabled={busy || confirmation !== 'DELETE JOURNEY'}
              onClick={() =>
                void run(async () => {
                  await api(`/trips/${trip.id}/delete`, token, {
                    confirmation,
                  });
                  await cache.invalidateQueries({ queryKey: ['trip'] });
                  await cache.invalidateQueries({ queryKey: ['trips'] });
                  setStatus('Private journey deleted.');
                })
              }
            >
              Delete private journey
            </Button>
          </>
        )}
      {status && <output>{status}</output>}
    </details>
  );
}
