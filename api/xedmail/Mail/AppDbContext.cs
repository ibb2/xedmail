using Microsoft.EntityFrameworkCore;
using xedmail.Model;

namespace xedmail.Mail;

public class AppDbContext : DbContext
{
    public AppDbContext(DbContextOptions<AppDbContext> options) : base(options)
    {
    }

    public DbSet<UserToken> UserTokens { get; set; }
    public DbSet<UserProfile> UserProfiles { get; set; }
    public DbSet<Mailbox> Mailboxes { get; set; }
};