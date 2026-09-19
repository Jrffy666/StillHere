'use client';
import 'leaflet/dist/leaflet.css';
import { useEffect, useRef, useState } from 'react';
import type { Map as LeafletMap } from 'leaflet';
import { LocateFixed, MapPin } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { Trip } from '@/lib/types';

export function JourneyMap({ trip }: { trip?: Trip }) {
  const element = useRef<HTMLDivElement>(null);
  const map = useRef<LeafletMap | null>(null);
  const [failed, setFailed] = useState(false);
  const lat = trip?.location.lat ?? 43.468,
    lng = trip?.location.lng ?? -80.533;
  const fromLat = trip?.origin.lat,
    fromLng = trip?.origin.lng,
    toLat = trip?.destination.lat,
    toLng = trip?.destination.lng,
    risk = trip?.risk,
    demo = trip?.demo;
  useEffect(() => {
    let disposed = false;
    void import('leaflet')
      .then((L) => {
        if (disposed || !element.current) return;
        const instance = L.map(element.current, {
          zoomControl: false,
          scrollWheelZoom: false,
        }).setView([lat, lng], 14);
        map.current = instance;
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          attribution:
            '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
          maxZoom: 19,
        }).addTo(instance);
        L.control.zoom({ position: 'bottomright' }).addTo(instance);
        if (
          fromLat !== undefined &&
          fromLng !== undefined &&
          toLat !== undefined &&
          toLng !== undefined
        ) {
          const start: L.LatLngExpression = [fromLat, fromLng];
          const end: L.LatLngExpression = [toLat, toLng];
          L.polyline([start, end], {
            color: '#b6a3f5',
            weight: 4,
            opacity: 0.75,
            dashArray: '8 8',
          }).addTo(instance);
          L.circleMarker(start, {
            radius: 6,
            color: '#fff',
            weight: 3,
            fillColor: '#b6f569',
            fillOpacity: 1,
          })
            .addTo(instance)
            .bindTooltip('Start', { permanent: false });
          L.circleMarker(end, {
            radius: 8,
            color: '#b6a3f5',
            weight: 3,
            fillColor: '#fff',
            fillOpacity: 1,
          })
            .addTo(instance)
            .bindTooltip('Destination', { permanent: false });
          L.circleMarker([lat, lng], {
            radius: 9,
            color: '#fff',
            weight: 3,
            fillColor: risk === 'urgent' ? '#ff9b92' : '#b6f569',
            fillOpacity: 1,
          })
            .addTo(instance)
            .bindTooltip(demo ? 'Simulated location' : 'Shared location');
          instance.fitBounds(
            L.latLngBounds([start, end, [lat, lng]]).pad(0.32),
          );
        }
      })
      .catch(() => setFailed(true));
    return () => {
      disposed = true;
      map.current?.remove();
      map.current = null;
    };
  }, [fromLat, fromLng, toLat, toLng, lat, lng, risk, demo]);
  return (
    <div className="journey-map">
      <div ref={element} className="leaflet-surface" />
      {failed && (
        <div className="map-fallback">
          <MapPin />
          <strong>Map unavailable</strong>
          <p>Your journey and check-ins are still available.</p>
        </div>
      )}
      <div className="map-label">
        <span className="pulse-dot" />
        {trip?.demo ? 'SIMULATED JOURNEY' : 'JOURNEY MAP'}
      </div>
      <Button
        variant="outline"
        className="map-recenter"
        onClick={() => map.current?.setView([lat, lng], 15)}
        aria-label="Center map on shared location"
      >
        <LocateFixed size={17} />
      </Button>
      <div className="map-footnote">
        {trip
          ? 'Dashed line connects endpoints; not driving directions.'
          : 'Waterloo, Ontario · Community care starts here.'}
      </div>
    </div>
  );
}
