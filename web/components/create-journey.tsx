'use client';
import { useState, type SyntheticEvent } from 'react';
import { ArrowRight, MapPin, Link as LinkIcon, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { api, errorMessage } from '@/lib/api';
import { PLACES, type Trip } from '@/lib/types';
import { CommunityNotice, useCommunityNotice } from '@/components/community-notice';

export function CreateJourney({
  open,
  onOpenChange,
  token,
  onCreated,
  chainAvailable,
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  token: string;
  onCreated: (trip: Trip) => void;
  chainAvailable: boolean;
}) {
  const [origin, setOrigin] = useState('0'),
    [destination, setDestination] = useState('1');
  const [shareUrl, setShareUrl] = useState(''),
    [contactName, setContactName] = useState(''),
    [contact, setContact] = useState('');
  const [interval, setInterval] = useState('60'),
    [consent, setConsent] = useState(false),
    [custom, setCustom] = useState(false);
  const [from, setFrom] = useState({ label: '', lat: '', lng: '' }),
    [to, setTo] = useState({ label: '', lat: '', lng: '' });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [chainEnabled, setChainEnabled] = useState(false);
  const communityNotice = useCommunityNotice(token);
  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!communityNotice.accepted) return;
    setError('');
    setBusy(true);
    try {
      const a = custom
        ? { label: from.label, lat: Number(from.lat), lng: Number(from.lng) }
        : PLACES[Number(origin)];
      const b = custom
        ? { label: to.label, lat: Number(to.lat), lng: Number(to.lng) }
        : PLACES[Number(destination)];
      if (a.lat === b.lat && a.lng === b.lng)
        throw new Error(
          'Choose a destination different from your starting point.',
        );
      if (
        (contact.trim() && !contactName.trim()) ||
        (!contact.trim() && contactName.trim())
      )
        throw new Error(
          'Add both a contact name and contact details, or leave both empty.',
        );
      const { trip } = await api<{ trip: Trip }>('/trips', token, {
        origin: a,
        destination: b,
        checkInIntervalSeconds: Number(interval),
        ...(shareUrl.trim() ? { shareUrl: shareUrl.trim() } : {}),
        ...(contact.trim()
          ? {
              emergencyContact: {
                name: contactName.trim(),
                contact: contact.trim(),
              },
            }
          : {}),
        notificationConsent: consent,
        chainEnabled: chainAvailable && chainEnabled,
      });
      onCreated(trip);
      onOpenChange(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!busy) {
          setError('');
          onOpenChange(value);
        }
      }}
    >
      <DialogContent className="journey-dialog">
        <DialogHeader>
          <DialogTitle>New journey</DialogTitle>
          <DialogDescription>
            Choose your journey. A community guardian can join you along the
            way.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="journey-form">
          <div className="form-section-title">
            <MapPin size={15} /> YOUR ROUTE{' '}
            <button type="button" onClick={() => setCustom(!custom)}>
              {custom ? 'Use Waterloo places' : 'Use custom locations'}
            </button>
          </div>
          {custom ? (
            <div className="custom-places">
              {[
                { title: 'Starting point', value: from, set: setFrom },
                { title: 'Destination', value: to, set: setTo },
              ].map((place) => (
                <fieldset key={place.title}>
                  <legend>{place.title}</legend>
                  <Input
                    aria-label={`${place.title} name`}
                    value={place.value.label}
                    onChange={(e) =>
                      place.set({ ...place.value, label: e.target.value })
                    }
                    placeholder="Place name"
                    required
                    maxLength={160}
                  />
                  <div className="coordinate-row">
                    <Input
                      aria-label={`${place.title} latitude`}
                      type="number"
                      step="any"
                      min="-90"
                      max="90"
                      value={place.value.lat}
                      onChange={(e) =>
                        place.set({ ...place.value, lat: e.target.value })
                      }
                      placeholder="Latitude"
                      required
                    />
                    <Input
                      aria-label={`${place.title} longitude`}
                      type="number"
                      step="any"
                      min="-180"
                      max="180"
                      value={place.value.lng}
                      onChange={(e) =>
                        place.set({ ...place.value, lng: e.target.value })
                      }
                      placeholder="Longitude"
                      required
                    />
                  </div>
                </fieldset>
              ))}
            </div>
          ) : (
            <>
              <label className="field-label" htmlFor="trip-origin">
                Starting point
              </label>
              <NativeSelect
                id="trip-origin"
                className="wide-select"
                value={origin}
                onChange={(e) => setOrigin(e.target.value)}
              >
                {PLACES.map((p, i) => (
                  <NativeSelectOption value={i} key={p.label}>
                    {p.label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <label className="field-label" htmlFor="trip-destination">
                Destination
              </label>
              <NativeSelect
                id="trip-destination"
                className="wide-select"
                value={destination}
                onChange={(e) => setDestination(e.target.value)}
              >
                {PLACES.map((p, i) => (
                  <NativeSelectOption value={i} key={p.label}>
                    {p.label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </>
          )}
          <label className="field-label" htmlFor="uber-link">
            <LinkIcon size={13} /> Uber share link <span>optional</span>
          </label>
          <Input
            id="uber-link"
            type="url"
            placeholder="https://…uber.com/…"
            value={shareUrl}
            onChange={(e) => setShareUrl(e.target.value)}
          />
          <p className="field-hint">
            The link is shared with your guardian. Live location comes from your
            device when you choose to share it.
          </p>
          <details className="simple-details journey-options">
          <summary>More options <span>Check-in timing, contact & wallet</span></summary>
          <label className="field-label" htmlFor="checkin">
            Guardian check-in interval
          </label>
          <NativeSelect
            id="checkin"
            className="wide-select"
            value={interval}
            onChange={(e) => setInterval(e.target.value)}
          >
            <NativeSelectOption value="30">Every 30 seconds</NativeSelectOption>
            <NativeSelectOption value="60">Every minute</NativeSelectOption>
            <NativeSelectOption value="120">Every 2 minutes</NativeSelectOption>
            <NativeSelectOption value="300">Every 5 minutes</NativeSelectOption>
          </NativeSelect>
          <div className="form-section-title">
            <Users size={15} /> A TRUSTED CONTACT <span>optional</span>
          </div>
          <div className="coordinate-row">
            <Input
              aria-label="Trusted contact name"
              placeholder="Contact name"
              value={contactName}
              onChange={(e) => setContactName(e.target.value)}
            />
            <Input
              aria-label="Trusted contact details"
              placeholder="Phone or email"
              value={contact}
              onChange={(e) => setContact(e.target.value)}
            />
          </div>
          <label className="consent-row" htmlFor="contact-consent">
            <Checkbox
              id="contact-consent"
              checked={consent}
              onCheckedChange={(value) => setConsent(value)}
            />
            <span>
              I authorize alerts containing my name and shared location to this
              contact. Delivery requires a connected notification provider.
            </span>
          </label>
          <label className="consent-row" htmlFor="chain-commitment">
            <Checkbox
              id="chain-commitment"
              checked={chainAvailable && chainEnabled}
              disabled={!chainAvailable}
              onCheckedChange={(value) => setChainEnabled(Boolean(value))}
            />
            <span>
              Also use wallet-signed guardian commitments. Rider and guardians
              sign each handoff and settle the V2 contribution pool.
            </span>
          </label>
          <p className="field-hint">
            {chainAvailable
              ? 'Uses Devnet SOL for transaction fees. Ordinary check-ins and help remain available while transactions are pending.'
              : 'Optional: link a wallet in Account & wallet for signed commitments. Community records are published separately, without requiring your wallet.'}
          </p>
          </details>
          {error && <p className="inline-error" role="alert">{error}</p>}
          <CommunityNotice token={token} />
          <Button type="submit" className="primary-action" disabled={busy || !communityNotice.accepted}>
            {busy ? 'Creating your journey…' : 'Create guarded journey'}
            <ArrowRight size={17} />
          </Button>
          <p className="field-hint centered">
            Your route and contact details are hidden from public journey
            listings.
          </p>
        </form>
      </DialogContent>
    </Dialog>
  );
}
