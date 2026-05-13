// StaffReport — Blueprint → Reports → Staff
//
// Wraps two sub-reports that previously lived as top-level tabs:
//   - Manicurists: productivity & sales credited to each manicurist
//     (excludes receptionists — they don't perform service lines).
//   - Receptionists: clock-in / clock-out log + total hours for
//     manicurist rows flagged is_receptionist.
//
// Switching tabs preserves the date range each child manages on its own.

import { useState } from 'react';
import { UserCheck, Clock } from 'lucide-react';
import ManicuristSalesReport from './ManicuristSalesReport';
import ReceptionistHoursReport from './ReceptionistHoursReport';

type SubTab = 'manicurists' | 'receptionists';

export default function StaffReport() {
  const [tab, setTab] = useState<SubTab>('manicurists');

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 pt-5">
        <div className="flex gap-2">
          <SubTabBtn
            active={tab === 'manicurists'}
            onClick={() => setTab('manicurists')}
            icon={<UserCheck size={14} />}
            label="MANICURISTS"
          />
          <SubTabBtn
            active={tab === 'receptionists'}
            onClick={() => setTab('receptionists')}
            icon={<Clock size={14} />}
            label="RECEPTIONIST"
          />
        </div>
      </div>
      <div className="flex-1 overflow-hidden">
        {tab === 'manicurists' ? <ManicuristSalesReport /> : <ReceptionistHoursReport />}
      </div>
    </div>
  );
}

function SubTabBtn({
  active, onClick, icon, label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 px-4 py-2 rounded-lg font-mono text-xs font-bold tracking-wider transition-colors ${
        active
          ? 'bg-gray-900 text-white'
          : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}
