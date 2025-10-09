namespace xedmail.Model;

public class Mailbox
{
    public Guid Id { get; set; }
    public string Provider { get; set; }           // e.g., "gmail", "outlook", "generic-imap"
    public string EmailAddress { get; set; }       // the mailbox email
    public string AccessToken { get; set; }        // Encrypted
    public string RefreshToken { get; set; }       // nullable if provider doesn't send one also Encrypted
    public DateTimeOffset? AccessTokenExpiresAt { get; set; }
    public string Scopes { get; set; }             // JSON or space-separated
    public bool IsActive { get; set; } = true;
    public DateTimeOffset? LastSyncAt { get; set; }
    public string ProviderMetadataJson { get; set; } // store provider specific JSON (token id, uidValidity)
    public string RefreshTokenHash { get; set; } // optionally store hash for revoke checks
    public string UserProfileClerkUserId { get; set; }
    public UserProfile UserProfile { get; set; }

}