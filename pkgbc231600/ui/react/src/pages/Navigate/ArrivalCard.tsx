import React, { useEffect, useMemo, useState } from 'react';
import { Check, Clock3, TriangleAlert } from 'lucide-react';

export default function ArrivalCard({
  routeSeconds,
}: {
  routeSeconds: number | null;
}) {
  const [classTime, setClassTime] = useState('');
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 15000);
    return () => clearInterval(timer);
  }, []);
  const verdict = useMemo(() => {
    if (routeSeconds === null || !/^\d{2}:\d{2}$/.test(classTime)) return null;
    const [hours, minutes] = classTime.split(':').map(Number);
    const target = new Date(now);
    target.setHours(hours, minutes, 0, 0);
    const arrival = new Date(now.getTime() + routeSeconds * 1000);
    const slack = (target.getTime() - arrival.getTime()) / 60000;
    return {
      late: slack < 0,
      text:
        slack < 0
          ? `About ${Math.ceil(-slack)} min late`
          : slack < 1
            ? 'You’ll arrive just in time'
            : `${Math.floor(slack)} min to spare`,
      arrival: arrival.toLocaleTimeString([], {
        hour: 'numeric',
        minute: '2-digit',
      }),
    };
  }, [now, classTime, routeSeconds]);
  return (
    <div className="arrival-card">
      <div className="arrival-heading">
        <Clock3 size={17} />
        <label htmlFor="tardy-class-time">
          Class starts at <span>(today)</span>
        </label>
        <input
          id="tardy-class-time"
          type="time"
          value={classTime}
          onChange={(event) => {
            setClassTime(event.target.value);
            setNow(new Date());
          }}
        />
      </div>
      {verdict ? (
        <div
          className={`arrival-verdict ${verdict.late ? 'late' : ''}`}
          role="status"
        >
          {verdict.late ? <TriangleAlert size={16} /> : <Check size={16} />}
          <span>
            <strong>{verdict.text}</strong>
            <small>Leave now · Estimated arrival {verdict.arrival}</small>
          </span>
        </div>
      ) : (
        <p>
          {classTime
            ? 'Add your route to check your arrival.'
            : 'A little early looks good on you.'}
        </p>
      )}
    </div>
  );
}
