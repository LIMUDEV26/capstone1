export const PROFILE_EDIT_FIELD_OPTIONS = [
    { key: 'first_name', label: 'First Name', group: 'Personal details' },
    { key: 'last_name', label: 'Last Name', group: 'Personal details' },
    { key: 'email', label: 'Email Address', group: 'Personal details' },
    { key: 'mobile_number', label: 'Mobile Number', group: 'Personal details' },
    { key: 'date_of_birth', label: 'Birthdate', group: 'Personal details' },
    { key: 'photo', label: 'Profile Picture', group: 'Personal details' },
    { key: 'sss_number', label: 'SSS Number', group: 'Government numbers' },
    { key: 'pagibig_number', label: 'Pag-IBIG Number', group: 'Government numbers' },
    { key: 'philhealth_number', label: 'PhilHealth Number', group: 'Government numbers' },
    { key: 'tin_number', label: 'TIN Number', group: 'Government numbers' },
    { key: 'password', label: 'Password', group: 'Account security' },
] as const;

export type ProfileEditFieldKey = (typeof PROFILE_EDIT_FIELD_OPTIONS)[number]['key'];

export const PROFILE_EDIT_FIELD_LABELS: Record<ProfileEditFieldKey, string> = Object.fromEntries(
    PROFILE_EDIT_FIELD_OPTIONS.map(({ key, label }) => [key, label])
) as Record<ProfileEditFieldKey, string>;

export const getProfileEditFieldLabels = (fields?: string[] | null) => {
    const requested = new Set(fields || []);
    return PROFILE_EDIT_FIELD_OPTIONS
        .filter(({ key }) => requested.has(key))
        .map(({ label }) => label);
};
