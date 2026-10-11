export const PROFILE_DOCUMENT_FIELDS = [
    { key: 'document_resume', label: 'Resume / CV' },
    { key: 'document_nbi_clearance', label: 'NBI Clearance' },
    { key: 'document_police_clearance', label: 'Police Clearance' },
    { key: 'document_barangay_clearance', label: 'Barangay Clearance' },
    { key: 'document_birth_certificate', label: 'Birth Certificate' },
    { key: 'document_medical_certificate', label: 'Medical Certificate' },
    { key: 'document_diploma_tor', label: 'Diploma / TOR' },
    { key: 'document_employment_contract', label: 'Signed Employment Contract' },
] as const;

export type ProfileDocumentFieldKey = (typeof PROFILE_DOCUMENT_FIELDS)[number]['key'];

export type ProfileDocumentStatusRecord = Partial<Record<ProfileDocumentFieldKey, number | boolean | null | undefined>>;

export function isProfileDocumentSubmitted(value: number | boolean | null | undefined) {
    return !!Number(value ?? 0) || value === true;
}

export function getProfileDocumentSummary(profile: ProfileDocumentStatusRecord | null | undefined) {
    const submittedFields = PROFILE_DOCUMENT_FIELDS.filter((item) => isProfileDocumentSubmitted(profile?.[item.key]));
    const missingFields = PROFILE_DOCUMENT_FIELDS.filter((item) => !isProfileDocumentSubmitted(profile?.[item.key]));

    return {
        submittedCount: submittedFields.length,
        totalCount: PROFILE_DOCUMENT_FIELDS.length,
        submittedFields,
        missingFields,
    };
}
